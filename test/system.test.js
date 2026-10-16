// Sony TV core polling, publication, and shutdown tests
// Part of homebridge-sonytv-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
import * as hap from '@homebridge/hap-nodejs';

import HomeKitDevice from '../dist/HomeKitDevice.js';
import SonyTVAccfactory from '../dist/system.js';
import SonyClient from '../dist/sonyclient.js';

function response(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}

test('core polling pushes state, skips overlaps, recovers failures, and stops on shutdown', async (context) => {
  // Mock only the core's configured interval; HomeKitDevice owns other timers.
  let poll;
  let cleared = false;
  let handle = { unref() {} };
  let originalSetInterval = timers.setInterval;
  let originalClearInterval = timers.clearInterval;
  context.mock.method(timers, 'setInterval', (callback, interval, ...args) => {
    if (interval === 2000) {
      assert.equal(poll, undefined);
      poll = callback;
      return handle;
    }
    return originalSetInterval(callback, interval, ...args);
  });
  context.mock.method(timers, 'clearInterval', (timer) => {
    if (timer === handle) {
      cleared = true;
      return;
    }
    return originalClearInterval(timer);
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  let release;
  let blocked = false;
  let fail = false;
  let status = SonyClient.prototype.status;
  context.mock.method(SonyClient.prototype, 'status', async function (options) {
    if (blocked === true) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    if (fail === true) {
      throw new Error('TV unavailable');
    }
    return status.call(this, options);
  });
  let updates = [];
  let message = HomeKitDevice.message;
  context.mock.method(HomeKitDevice, 'message', function (uuid, type, values, ...args) {
    if (type === HomeKitDevice.UPDATE) {
      updates.push(values);
    }
    return message.call(this, uuid, type, values, ...args);
  });
  let events = new Map();
  let published = [];
  let removedFromCache = [];
  let api = {
    hap,
    version: 2,
    platformAccessory: hap.Accessory,
    on(event, callback) {
      events.set(event, [...(events.get(event) ?? []), callback]);
    },
    publishExternalAccessories(_plugin, accessories) {
      published.push(...accessories);
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories(_plugin, _platform, accessories) {
      removedFromCache.push(...accessories);
    },
  };
  let log = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, () => {}]));
  let powerRequests = 0;
  let systemInformationRequests = 0;

  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    let method = JSON.parse(options.body).method;
    let values = {
      getPlayingContentInfo: [{ source: 'extInput:hdmi?port=1', uri: 'extInput:hdmi?port=1' }],
      getVolumeInformation: [[{ target: 'speaker', volume: '25', minVolume: 0, maxVolume: 100, mute: false }]],
      getSystemInformation: [{ model: 'KD-55X9000', serial: '12345', generation: '9.0.0', macAddr: 'AA:BB:CC:DD:EE:FF' }],
      getCurrentExternalInputsStatus: [[{ uri: 'extInput:hdmi?port=1', title: 'HDMI 1', label: '', icon: 'meta:hdmi' }]],
      getSourceList: [[]],
      getRemoteControllerInfo: [{}, []],
    };

    if (method === 'getPowerStatus') {
      powerRequests += 1;
      return response([{ status: powerRequests === 1 ? 'active' : 'standby' }]);
    }
    if (method === 'getSystemInformation') {
      systemInformationRequests += 1;
    }
    return response(values[method]);
  });

  HomeKitDevice.PLUGIN_NAME = 'homebridge-sonytv-accfactory';
  HomeKitDevice.PLATFORM_NAME = 'SonyTVAccfactory';
  HomeKitDevice.LOGGER = log;

  let platform = new SonyTVAccfactory(log, { options: { autoDiscover: false, pollInterval: 2 }, devices: [{ host: '10.0.0.2' }] }, api);
  let legacyAccessory = new hap.Accessory('Legacy television', hap.uuid.generate('legacy-television'));
  platform.configureAccessory(legacyAccessory);
  assert.deepEqual(removedFromCache, [legacyAccessory]);

  try {
    await events.get('didFinishLaunching')[0]();
    assert.equal(published.length, 1);

    let active = published[0].getService(hap.Service.Television).getCharacteristic(hap.Characteristic.Active);
    assert.equal(active.value, hap.Characteristic.Active.ACTIVE);

    // The accessory no longer initiates network reads through TIMER or GET.
    await HomeKitDevice.message(published[0].UUID, HomeKitDevice.TIMER, { timer: 'status' });
    assert.equal(powerRequests, 1);
    assert.equal(typeof poll, 'function');
    await poll();

    assert.equal(powerRequests, 2);
    assert.equal(systemInformationRequests, 1);
    assert.equal(active.value, hap.Characteristic.Active.INACTIVE);

    blocked = true;
    let pending = poll();
    await poll();
    assert.equal(powerRequests, 2);
    blocked = false;
    release();
    await pending;
    assert.equal(powerRequests, 3);

    fail = true;
    await poll();
    assert.deepEqual(updates.at(-1), { online: false });
    assert.equal(active.value, hap.Characteristic.Active.INACTIVE);
    fail = false;
    await poll();
    assert.equal(updates.at(-1).online, true);
    assert.equal(powerRequests, 4);

    blocked = true;
    pending = poll();
    let updateCount = updates.length;
    let stopped = false;
    let shutdown = events
      .get('shutdown')[0]()
      .then(() => {
        stopped = true;
      });
    assert.equal(cleared, true);
    await poll();
    assert.equal(stopped, false);
    blocked = false;
    release();
    await Promise.all([pending, shutdown]);
    assert.equal(updates.length, updateCount);
    let requestCount = powerRequests;
    await poll();
    assert.equal(powerRequests, requestCount);
  } finally {
    for (let callback of events.get('shutdown') ?? []) {
      await callback();
    }
  }
});

test('an excluded TV override is inspected but not published', async (context) => {
  let events = new Map();
  let published = [];
  let warnings = [];
  let api = {
    hap,
    version: 2,
    platformAccessory: hap.Accessory,
    on(event, callback) {
      events.set(event, [...(events.get(event) ?? []), callback]);
    },
    publishExternalAccessories(_plugin, accessories) {
      published.push(...accessories);
    },
    updatePlatformAccessories() {},
  };
  let log = Object.fromEntries(['info', 'success', 'error', 'debug'].map((level) => [level, () => {}]));
  log.warn = (...args) => warnings.push(args);

  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    let method = JSON.parse(options.body).method;
    let values = {
      getPowerStatus: [{ status: 'active' }],
      getPlayingContentInfo: [{ source: 'extInput:hdmi?port=1', uri: 'extInput:hdmi?port=1' }],
      getVolumeInformation: [[{ target: 'speaker', volume: '25', minVolume: 0, maxVolume: 100, mute: false }]],
      getSystemInformation: [{ model: 'KD-55X9000', serial: 'EXCLUDED', generation: '9.0.0', macAddr: 'AA:BB:CC:DD:EE:FF' }],
      getCurrentExternalInputsStatus: [[{ uri: 'extInput:hdmi?port=1', title: 'HDMI 1', label: '', icon: 'meta:hdmi' }]],
      getSourceList: [[]],
      getRemoteControllerInfo: [{}, []],
    };
    return response(values[method]);
  });

  HomeKitDevice.PLUGIN_NAME = 'homebridge-sonytv-accfactory';
  HomeKitDevice.PLATFORM_NAME = 'SonyTVAccfactory';
  HomeKitDevice.LOGGER = log;

  new SonyTVAccfactory(log, { options: { autoDiscover: false }, devices: [{ host: '10.0.0.3', exclude: true }] }, api);
  await events.get('didFinishLaunching')[0]();

  assert.equal(published.length, 0);
  assert.equal(
    warnings.some((entry) => entry[0].includes('marked as excluded')),
    true,
  );
});
