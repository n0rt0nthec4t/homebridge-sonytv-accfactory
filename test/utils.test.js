// Shared utility tests
// Part of homebridge-sonytv-accfactory

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWrapper } from '../src/fetchWrapper/fetchWrapper.js';
import { crc32, scaleValue } from '../src/utils.js';

test('crc32 returns a stable unsigned identifier', () => {
  assert.equal(crc32('extInput:hdmi?port=1'), 3322201961);
});

test('scale bounds and maps Sony volume values', () => {
  assert.equal(scaleValue('-50', -100, 0, 0, 100), 50);
  assert.equal(scaleValue(20, -100, 0, 0, 100), 100);
  assert.equal(scaleValue('invalid', -100, 0, 0, 100), undefined);
});

test('fetchWrapper serialises JSON through the fetch boundary', async () => {
  let received;
  let originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    received = { url, options };
    return { ok: true, status: 200 };
  };

  let response;
  try {
    response = await fetchWrapper(fetchWrapper.POST, 'http://bravia.local/sony/system', { timeout: 5000 }, { method: 'getPowerStatus' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(response.status, 200);
  assert.equal(received.options.headers.get('Content-Type'), 'application/json');
  assert.equal(received.options.body, '{"method":"getPowerStatus"}');
});
