// Sony TV timer-driven update tests
// Part of homebridge-sonytv-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';
import * as hap from '@homebridge/hap-nodejs';

import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import SonyTVAccfactory from '../src/system.js';

function response(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}

test('television timer requests a fresh snapshot through the system GET handler', async (context) => {
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

  let platform = new SonyTVAccfactory(
    log,
    { options: { autoDiscover: false, pollInterval: 2 }, devices: [{ host: '10.0.0.2' }] },
    api,
  );
  let legacyAccessory = new hap.Accessory('Legacy television', hap.uuid.generate('legacy-television'));
  platform.configureAccessory(legacyAccessory);
  assert.deepEqual(removedFromCache, [legacyAccessory]);

  try {
    await events.get('didFinishLaunching')[0]();
    assert.equal(published.length, 1);

    let active = published[0].getService(hap.Service.Television).getCharacteristic(hap.Characteristic.Active);
    assert.equal(active.value, hap.Characteristic.Active.ACTIVE);

    await HomeKitDevice.message(published[0].UUID, HomeKitDevice.TIMER, { timer: 'status' });

    assert.equal(powerRequests, 2);
    assert.equal(systemInformationRequests, 1);
    assert.equal(active.value, hap.Characteristic.Active.INACTIVE);
  } finally {
    for (let callback of events.get('shutdown') ?? []) {
      await callback();
    }
  }
});
