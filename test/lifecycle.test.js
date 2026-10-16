// Sony lifecycle regression tests for identity, command delivery, and recovery.
// Uses isolated clients and timers without connecting to physical TVs.
import assert from 'node:assert/strict';
import test from 'node:test';
import timers from 'node:timers';
import { syncBuiltinESMExports } from 'node:module';
import * as hap from '@homebridge/hap-nodejs';

import HomeKitDevice from '../dist/HomeKitDevice.js';
import SonyClient from '../dist/sonyclient.js';
import SonyTVAccfactory from '../dist/system.js';
import { crc32 } from '../dist/utils.js';

function setup(context, devices = [{ host: 'tv.local' }]) {
  let handles = [];
  context.mock.method(timers, 'setInterval', (callback, interval) => {
    let handle = { callback, interval, cleared: false, unref() {} };
    handles.push(handle);
    return handle;
  });
  context.mock.method(timers, 'clearInterval', (handle) => {
    if (handle !== undefined) {
      handle.cleared = true;
    }
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });

  let events = new Map();
  let published = [];
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
  let log = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, () => {}]));
  HomeKitDevice.PLUGIN_NAME = 'homebridge-sonytv-accfactory';
  HomeKitDevice.PLATFORM_NAME = 'SonyTVAccfactory';

  // All aliases in this runtime describe the same physical TV.
  context.mock.method(SonyClient.prototype, 'snapshot', async function () {
    return {
      serialNumber: 'LIFECYCLE-TV',
      softwareVersion: '1',
      manufacturer: 'Sony',
      model: 'BRAVIA',
      description: 'Lounge TV',
      host: this.baseUrl,
      power: true,
      mute: false,
      volume: 25,
      online: true,
      activeInput: { input: 'hdmi:1', source: '' },
      inputs: [
        { uri: 'hdmi:1', title: 'HDMI 1', type: 'HDMI' },
        { uri: 'hdmi:2', title: 'HDMI 2', type: 'HDMI' },
      ],
      remoteCommands: { UP: 'remote-up' },
    };
  });
  context.mock.method(SonyClient.prototype, 'status', async () => ({ online: true }));
  new SonyTVAccfactory(log, { options: { autoDiscover: false, pollInterval: 2, discoveryInterval: 30 }, devices }, api);
  return {
    handles,
    published,
    api,
    start: () => events.get('didFinishLaunching')[0](),
    stop: async () => {
      for (let callback of events.get('shutdown') ?? []) {
        await callback();
      }
    },
  };
}

test('concurrent host aliases publish once and clear every polling subscription', async (context) => {
  let runtime = setup(context, [{ host: 'tv.local' }, { host: '10.0.0.2' }]);
  try {
    await runtime.start();
    assert.equal(runtime.published.length, 1);
    assert.equal(runtime.handles.length, 1);
    assert.equal(runtime.handles[0].interval, 2000);
  } finally {
    await runtime.stop();
  }
  assert.equal(runtime.handles.every((handle) => handle.cleared === true), true);
});

test('rapid opposite power, input, and mute writes reach the client in order', async (context) => {
  let runtime = setup(context);
  let writes = [];
  let release;
  let entered;
  let started = new Promise((resolve) => {
    entered = resolve;
  });
  context.mock.method(SonyClient.prototype, 'setPower', async (value) => {
    writes.push(['power', value]);
    if (value === false) {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
  });
  context.mock.method(SonyClient.prototype, 'setInput', async (value) => writes.push(['input', value]));
  context.mock.method(SonyClient.prototype, 'setMute', async (value) => writes.push(['mute', value]));
  let pending = [];
  try {
    await runtime.start();
    let television = runtime.published[0].getService(hap.Service.Television);
    let active = television.getCharacteristic(hap.Characteristic.Active);
    let input = television.getCharacteristic(hap.Characteristic.ActiveIdentifier);
    let mute = runtime.published[0].getService(hap.Service.TelevisionSpeaker).getCharacteristic(hap.Characteristic.Mute);
    pending.push(active.handleSetRequest(hap.Characteristic.Active.INACTIVE));
    await started;
    pending.push(active.handleSetRequest(hap.Characteristic.Active.ACTIVE));
    pending.push(input.handleSetRequest(crc32('hdmi:2')));
    pending.push(input.handleSetRequest(crc32('hdmi:1')));
    pending.push(mute.handleSetRequest(true));
    pending.push(mute.handleSetRequest(false));
    await Promise.resolve();
    assert.deepEqual(writes, [['power', false]]);
    release();
    await Promise.all(pending);
    assert.deepEqual(writes, [
      ['power', false], ['power', true], ['input', 'hdmi:2'], ['input', 'hdmi:1'], ['mute', true], ['mute', false],
    ]);
  } finally {
    release?.();
    await Promise.allSettled(pending);
    await runtime.stop();
  }
});

test('command errors reject HomeKit writes and subsequent commands still work', async (context) => {
  let runtime = setup(context);
  let fail = true;
  let writes = [];
  context.mock.method(SonyClient.prototype, 'setMute', async (value) => {
    writes.push(value);
    if (fail === true) {
      throw new Error('Sony API refused command');
    }
  });
  try {
    await runtime.start();
    let mute = runtime.published[0].getService(hap.Service.TelevisionSpeaker).getCharacteristic(hap.Characteristic.Mute);
    await assert.rejects(mute.handleSetRequest(true), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    fail = false;
    await mute.handleSetRequest(false);
    assert.deepEqual(writes, [true, false]);
  } finally {
    await runtime.stop();
  }
});

test('manual TV unavailable at startup retries without SSDP and stops retrying once published', async (context) => {
  let runtime = setup(context);
  let snapshot = SonyClient.prototype.snapshot;
  let attempts = 0;
  let release;
  let ready = false;
  context.mock.method(SonyClient.prototype, 'snapshot', async function () {
    attempts += 1;
    if (ready === false) {
      throw new Error('TV is offline');
    }
    await new Promise((resolve) => {
      release = resolve;
    });
    return snapshot.call(this);
  });
  let pending;
  try {
    await runtime.start();
    assert.equal(runtime.published.length, 0);
    assert.equal(attempts, 1);
    let retry = runtime.handles.find((handle) => handle.interval === 30000);
    assert.ok(retry);
    ready = true;
    pending = retry.callback();
    let duplicate = retry.callback();
    await Promise.resolve();
    assert.equal(attempts, 2);
    release();
    await Promise.all([pending, duplicate]);
    assert.equal(runtime.published.length, 1);
    assert.equal(retry.cleared, true);
    assert.equal(runtime.handles.filter((handle) => handle.cleared === false).length, 1);
  } finally {
    release?.();
    await pending;
    await runtime.stop();
  }
  assert.equal(runtime.handles.every((handle) => handle.cleared === true), true);
});

test('shutdown drains an in-flight startup retry without publishing its result', async (context) => {
  let runtime = setup(context);
  let snapshot = SonyClient.prototype.snapshot;
  let attempts = 0;
  let release;
  context.mock.method(SonyClient.prototype, 'snapshot', async function () {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('Offline');
    }
    await new Promise((resolve) => {
      release = resolve;
    });
    return snapshot.call(this);
  });
  await runtime.start();
  let retry = runtime.handles.find((handle) => handle.interval === 30000);
  let pending = retry.callback();
  let stopped = runtime.stop();
  release();
  await Promise.all([pending, stopped]);
  await retry.callback();
  assert.equal(attempts, 2);
  assert.equal(runtime.published.length, 0);
  assert.equal(retry.cleared, true);
});

test('failed publication cleans up and remains retryable', async (context) => {
  let runtime = setup(context);
  let publish = runtime.api.publishExternalAccessories;
  let attempts = 0;
  context.mock.method(runtime.api, 'publishExternalAccessories', (...args) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('Publication failed');
    }
    return publish(...args);
  });
  try {
    await runtime.start();
    assert.equal(runtime.published.length, 0);
    let retry = runtime.handles.find((handle) => handle.interval === 30000);
    assert.ok(retry);
    await retry.callback();
    assert.equal(runtime.published.length, 1);
    assert.equal(attempts, 2);
    assert.equal(retry.cleared, true);
    assert.equal(runtime.handles.filter((handle) => handle.cleared === false).length, 1);
  } finally {
    await runtime.stop();
  }
});
