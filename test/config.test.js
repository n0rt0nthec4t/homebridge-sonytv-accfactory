// Configuration processing tests
// Part of homebridge-sonytv-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';

import { processConfig } from '../src/config.js';

test('processConfig supplies compatible defaults', () => {
  let config = processConfig({});
  assert.equal(config.options.autoDiscover, true);
  assert.equal(config.options.psk, '0000');
  assert.equal(config.options.pollInterval, 5);
  assert.deepEqual(config.devices, []);
});

test('processConfig validates and normalises manual devices', () => {
  let config = processConfig({
    options: { pollInterval: 1, discoveryInterval: 5, includeChannels: true },
    devices: [{ host: ' tv.local ', name: ' Lounge ', includeApplications: true }, { name: 'Missing host' }],
  });
  assert.equal(config.options.pollInterval, 2);
  assert.equal(config.options.discoveryInterval, 30);
  assert.deepEqual(config.devices, [
    { host: 'tv.local', name: 'Lounge', psk: undefined, includeApplications: true, includeChannels: true },
  ]);
});
