// Sony TV SSDP Discovery
// Part of homebridge-sonytv-accfactory
//
// Finds Sony ScalarWebAPI devices using the UPnP SSDP multicast protocol.
//
// Responsibilities:
// - Send periodic M-SEARCH requests for Sony ScalarWebAPI services
// - Parse case-insensitive SSDP response headers
// - Forward candidate addresses for authenticated identity inspection
// - Release socket and timer resources cleanly during shutdown
//
// Notes:
// - SSDP only supplies candidates; SonyClient verifies every responding device
// - Discovery is additive because multicast replies can be lost intermittently
//
// Code version 2026.09.10
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { clearInterval, setInterval } from 'node:timers';

// Define constants for the SSDP multicast address, port, and Sony ScalarWebAPI service type
const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SONY_SERVICE = 'urn:schemas-sony-com:service:ScalarWebAPI:1';

// Build the discovery packet once since every search broadcasts the same query.
// MX asks devices to respond within two seconds, while ST limits responses to
// Sony televisions advertising the ScalarWebAPI service used by this plugin.
const QUERY = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\n' +
    'HOST: ' +
    SSDP_ADDRESS +
    ':' +
    SSDP_PORT +
    '\r\n' +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 2\r\n' +
    'ST: ' +
    SONY_SERVICE +
    '\r\n\r\n',
);

function startDiscovery({ onDevice, onError, interval = 60000, interfaceAddress } = {}, createUdpSocket = createSocket) {
  // Callbacks are mandatory because discovery deliberately knows nothing about
  // platform logging or how a candidate television becomes an accessory.
  if (typeof onDevice !== 'function' || typeof onError !== 'function') {
    throw new TypeError('Discovery requires onDevice and onError callbacks');
  }

  // Node's multicast interface option requires an IPv4 address, not a hostname
  // or interface name. Leaving it undefined lets the operating system choose.
  if (interfaceAddress !== undefined && isIPv4(interfaceAddress) === false) {
    throw new TypeError('Discovery interfaceAddress must be an IPv4 address');
  }

  // Keep the socket lifecycle local to this discovery session. The injected
  // socket factory also allows the network boundary to be tested independently.
  let stopped = false;
  let ready = false;
  let timer;
  let socket = createUdpSocket({ type: 'udp4', reuseAddr: true });

  let reportError = (error) => {
    if (stopped === false) {
      // A consumer may use an asynchronous error handler. Contain any rejection
      // so error reporting itself cannot create an unhandled promise rejection.
      Promise.resolve(onError(error)).catch(() => {});
    }
  };

  let search = () => {
    // Sending before the socket is listening can fail on some platforms. A
    // stopped session must also remain inert if a queued timer fires late.
    if (ready === false || stopped === true) {
      return;
    }

    socket.send(QUERY, SSDP_PORT, SSDP_ADDRESS, (error) => {
      if (error !== null) {
        reportError(error);
      }
    });
  };

  socket.on('message', (message, remote) => {
    // SSDP headers are case-insensitive. Store their names in lower case so the
    // response filter does not depend on how an individual TV formats its reply.
    let lines = message.toString('utf8').split(/\r?\n/);
    let status = lines.shift()?.trim() ?? ''; // First line is the HTTP-style status
    let headers = Object.create(null);
    for (let line of lines) {
      let separator = line.indexOf(':');
      if (separator > 0) {
        // Split only on the first colon because header values may contain URLs.
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      }
    }

    let service = ((headers.st ?? '') + ' ' + (headers.usn ?? '')).toLowerCase();

    // Accept successful replies that identify the Sony ScalarWebAPI service.
    // Discovery only reports a network candidate; SonyClient later authenticates
    // it and reads the stable serial number before an accessory is registered.
    if (/^HTTP\/1\.[01] 200\b/i.test(status) === true && service.includes('schemas-sony-com:service:scalarwebapi') === true) {
      Promise.resolve(onDevice({ host: remote.address, address: remote.address, location: headers.location })).catch(reportError);
    }
  });

  socket.on('error', reportError);
  socket.on('listening', () => {
    ready = true;

    try {
      // Keep multicast traffic on the local network and honour an explicitly
      // selected interface on hosts with more than one network connection.
      socket.setBroadcast(true);
      socket.setMulticastTTL(2);
      if (interfaceAddress !== undefined) {
        socket.setMulticastInterface(interfaceAddress);
      }

      // Search immediately, then periodically. Thirty seconds is the minimum to
      // avoid flooding the local network when an invalid interval is supplied.
      search();
      let configuredInterval = Number(interval);
      configuredInterval = Number.isFinite(configuredInterval) === true && configuredInterval !== 0 ? configuredInterval : 60000;
      timer = setInterval(search, Math.max(30000, configuredInterval));
    } catch (error) {
      reportError(error);
    }
  });

  // Bind to an ephemeral local port on all IPv4 interfaces so responses can be
  // received without reserving the standard SSDP listener port.
  socket.bind(0, '0.0.0.0');

  return {
    // Expose a manual search for callers that want an immediate refresh.
    search,

    stop() {
      // Shutdown is intentionally idempotent because Homebridge and error paths
      // may both attempt to release discovery resources.
      if (stopped === true) {
        return;
      }

      stopped = true;
      ready = false;
      clearInterval(timer);
      socket.removeAllListeners();

      try {
        socket.close();
      } catch {
        // Socket may already be closed after an asynchronous error.
      }
    },
  };
}

export { startDiscovery };
