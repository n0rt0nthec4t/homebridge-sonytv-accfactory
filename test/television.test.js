// HomeKit television integration tests
// Part of homebridge-sonytv-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';
import * as hap from '@homebridge/hap-nodejs';

import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import Television from '../src/television.js';

test('Television prepares a stable bounded input topology', () => {
  let inputs = [
    { uri: 'physical:z', type: 'HDMI' },
    { uri: 'app:z', type: 'APPLICATION' },
    { uri: 'tuner:z', type: 'TUNER' },
    { uri: 'physical:a', type: 'COMPOSITE' },
    ...Array.from({ length: 90 }, (_, index) => ({ uri: `channel:${String(index).padStart(2, '0')}`, type: 'CHANNEL' })),
  ];
  let ordered = Television.prepareInputs(inputs).map((input) => input.uri);

  assert.equal(ordered.length, Television.MAX_INPUTS);
  assert.deepEqual(ordered.slice(0, 4), ['physical:a', 'physical:z', 'tuner:z', 'app:z']);
  assert.deepEqual(Television.prepareInputs([...inputs].reverse()).map((input) => input.uri), ordered);
  assert.equal(inputs[0].uri, 'physical:z');
});

test('Television creates the expected HAP services through HomeKitDevice', async () => {
  let registered = [];
  let api = {
    hap,
    version: 2,
    platformAccessory: hap.Accessory,
    on() {},
    registerPlatformAccessories(_plugin, _platform, accessories) {
      registered.push(...accessories);
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories() {},
  };
  let log = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, () => {}]));
  let commands = [];
  let deviceData = {
    serialNumber: '12345',
    softwareVersion: '9.0.0',
    description: 'Lounge TV',
    manufacturer: 'Sony',
    model: 'KD-55X9000',
    host: 'http://10.0.0.2',
    power: true,
    activeInput: { input: 'extInput:hdmi?port=1', source: '' },
    volume: 25,
    mute: false,
    inputs: [{ uri: 'extInput:hdmi?port=1', title: 'HDMI 1', label: 'Apple TV', type: 'HDMI', hidden: false }],
    remoteCommands: { UP: 'remote-up' },
    online: true,
    pollInterval: 300,
    includeApplications: false,
    includeChannels: false,
  };

  HomeKitDevice.PLUGIN_NAME = 'homebridge-sonytv-accfactory';
  HomeKitDevice.PLATFORM_NAME = 'SonyTVAccfactory';
  HomeKitDevice.LOGGER = log;

  let television = new Television(undefined, api, deviceData);

  try {
    let added = await television.add({
      hapAccessoryName: 'Sony Television',
      hapCategory: hap.Categories.TELEVISION,
      enableHistory: false,
    });

    assert.equal(added, true);
    assert.equal(registered.length, 1);
    assert.ok(television.accessory.getService(hap.Service.Television));
    assert.ok(television.accessory.getService(hap.Service.TelevisionSpeaker));
    assert.equal(television.accessory.services.filter((service) => service.UUID === hap.Service.InputSource.UUID).length, 1);
    assert.equal(television.accessory.context?.inputSettings, undefined);
    assert.equal(television.hasTimer('status'), true);

    let originalInput = television.accessory.services.find((service) => service.UUID === hap.Service.InputSource.UUID);
    originalInput.updateCharacteristic(hap.Characteristic.ConfiguredName, 'My Apple TV');
    await television.update({
      inputs: [{ uri: 'extInput:hdmi?port=2', title: 'HDMI 2', label: '', type: 'HDMI', hidden: false }],
    });
    assert.equal(television.accessory.services.filter((service) => service.UUID === hap.Service.InputSource.UUID).length, 1);
    assert.equal(originalInput.getCharacteristic(hap.Characteristic.ConfiguredName).value, 'My Apple TV');

    HomeKitDevice.message(television.uuid, HomeKitDevice.SET, async (values) => commands.push(values));

    await television.setPower(hap.Characteristic.Active.INACTIVE);
    assert.deepEqual(commands, [{ command: 'setPower', value: false }]);

    // Homebridge has already registered accessories supplied through
    // configureAccessory(), so restoring one must not register it again.
    let cachedAccessory = television.accessory;
    await television.shutdown();
    television = new Television(cachedAccessory, api, {
      ...deviceData,
      inputs: [...deviceData.inputs, { uri: 'extInput:hdmi?port=2', title: 'HDMI 2', label: '', type: 'HDMI', hidden: false }],
    });
    added = await television.add({
      hapAccessoryName: 'Sony Television',
      hapCategory: hap.Categories.TELEVISION,
      enableHistory: false,
    });

    assert.equal(added, true);
    assert.equal(registered.length, 1);
    assert.equal(television.accessory.services.filter((service) => service.UUID === hap.Service.InputSource.UUID).length, 1);
  } finally {
    await television.shutdown();
  }
});
