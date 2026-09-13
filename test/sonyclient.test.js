// Sony ScalarWebAPI client tests
// Part of homebridge-sonytv-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';

import SonyClient from '../src/sonyclient.js';

function response(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}

test('constructor and setHost validate Sony TV addresses', () => {
  let client = new SonyClient('bravia.local', 'secret');
  assert.equal(client.baseUrl, 'http://bravia.local');
  assert.throws(() => client.setHost('ftp://bravia.local'), /HTTP or HTTPS/);
});

test('snapshot converts Sony API data into device data', async (context) => {
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    let requestBody = JSON.parse(options.body);
    let values = {
      getPowerStatus: [{ status: 'active' }],
      getPlayingContentInfo: [{ source: 'extInput:hdmi?port=1', uri: 'extInput:hdmi?port=1' }],
      getVolumeInformation: [[{ target: 'speaker', volume: '25', minVolume: 0, maxVolume: 100, mute: false }]],
      getSystemInformation: [{ name: 'BRAVIA', model: 'KD-55X9000', serial: '12345', generation: '9.0.0', macAddr: 'AA:BB:CC:DD:EE:FF' }],
      getCurrentExternalInputsStatus: [[{ uri: 'extInput:hdmi?port=1', title: 'HDMI 1', label: 'Apple TV', icon: 'meta:hdmi' }]],
      getSourceList: [[{ source: 'tv:dvbt' }]],
      getRemoteControllerInfo: [{}, [{ name: 'Up', value: 'AAAAAQAAAAEAAAB0Aw==' }]],
      getApplicationList: [
        [{ title: 'YouTube', uri: 'com.sony.dtv.com.google.android.youtube.tv.com.google.android.apps.youtube.tv.activity.ShellActivity' }],
      ],
    };
    return response(values[requestBody.method]);
  });

  let client = new SonyClient('10.0.0.2', 'secret');
  let data = await client.snapshot({ name: 'GUI label only', includeApplications: true });
  assert.equal(data.serialNumber, '12345');
  assert.equal(data.description, 'BRAVIA');
  assert.equal(data.power, true);
  assert.equal(data.activeInput.input, 'extInput:hdmi?port=1');
  assert.equal(data.inputs.length, 3);
  assert.equal(data.remoteCommands.UP, 'AAAAAQAAAAEAAAB0Aw==');
});

test('status polls only mutable television state', async (context) => {
  let methods = [];
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    let method = JSON.parse(options.body).method;
    methods.push(method);
    let values = {
      getPowerStatus: [{ status: 'active' }],
      getPlayingContentInfo: [{ source: 'tv:dvbt', uri: 'tv:dvbt?triplet=1.2.3' }],
      getVolumeInformation: [[{ target: 'speaker', volume: '25', minVolume: 0, maxVolume: 100, mute: true }]],
    };
    return response(values[method]);
  });

  let client = new SonyClient('10.0.0.2', 'secret');
  let data = await client.status({ inputs: [{ uri: 'tv:dvbt' }] });

  assert.deepEqual(methods.sort(), ['getPlayingContentInfo', 'getPowerStatus', 'getVolumeInformation']);
  assert.deepEqual(data, {
    online: true,
    power: true,
    activeInput: { input: 'tv:dvbt', source: 'tv:dvbt?triplet=1.2.3' },
    volume: 25,
    mute: true,
  });
});

test('status omits state from an endpoint that failed', async (context) => {
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    let method = JSON.parse(options.body).method;
    if (method === 'getVolumeInformation') {
      return { ok: true, status: 200, json: async () => ({ error: [15, 'Unsupported'] }) };
    }
    if (method === 'getPowerStatus') {
      return response([{ status: 'standby' }]);
    }
    return response([{ source: '', uri: '' }]);
  });

  let data = await new SonyClient('10.0.0.2', 'secret').status();
  assert.equal(data.power, false);
  assert.equal(Object.hasOwn(data, 'volume'), false);
  assert.equal(Object.hasOwn(data, 'mute'), false);
});

test('request reports Sony JSON API errors', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ error: [403, 'Forbidden'] }) }));
  let client = new SonyClient('10.0.0.2', 'bad-key');
  await assert.rejects(client.request('system', 'getSystemInformation'), /403: Forbidden/);
});

test('read requests retry transient failures', async (context) => {
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    return response([{ status: 'active' }]);
  });

  let client = new SonyClient('10.0.0.2', 'secret');
  assert.deepEqual(await client.request('system', 'getPowerStatus'), [{ status: 'active' }]);
  assert.equal(attempts, 2);
});

test('control requests are not retried', async (context) => {
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  });

  let client = new SonyClient('10.0.0.2', 'secret');
  await assert.rejects(client.setPower(true), /failed after 1 attempt/);
  assert.equal(attempts, 1);
});
