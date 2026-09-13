// SSDP discovery tests
// Part of homebridge-sonytv-accfactory

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { startDiscovery } from '../src/discovery.js';

test('startDiscovery handles case-insensitive Sony SSDP responses', () => {
  let socket = new EventEmitter();
  socket.bind = () => {};
  socket.close = () => {};
  let candidates = [];
  let discovery = startDiscovery(
    {
      onDevice: (candidate) => candidates.push(candidate),
      onError: (error) => assert.fail(error),
    },
    () => socket,
  );

  socket.emit(
    'message',
    Buffer.from('HTTP/1.1 200 OK\r\nST: urn:schemas-sony-com:service:ScalarWebAPI:1\r\nLOCATION: http://10.0.0.2/sony.xml\r\n\r\n'),
    { address: '10.0.0.2' },
  );

  assert.deepEqual(candidates, [{ host: '10.0.0.2', address: '10.0.0.2', location: 'http://10.0.0.2/sony.xml' }]);
  discovery.stop();
});
