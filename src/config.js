// Configuration Processing
// Part of homebridge-sonytv-accfactory
//
// Validates user configuration and applies safe defaults before the platform
// opens sockets, performs network requests, or creates accessories.
//
// Responsibilities:
// - Apply discovery and polling defaults
// - Bound configured timer intervals
// - Normalise manual TV entries, per-device overrides, and exclusions
// - Warn when configuration cannot yield any devices
//
// Code version 2026.09.11
// Mark Hulskamp
'use strict';

export function processConfig(config = {}, log = undefined) {
  let source = config?.constructor === Object ? config : {};
  let options = source?.options?.constructor === Object ? source.options : {};
  let devices = Array.isArray(source?.devices) === true ? source.devices : [];

  let processed = {
    ...source,
    options: {
      autoDiscover: options?.autoDiscover !== false,
      psk: typeof options?.psk === 'string' && options.psk !== '' ? options.psk : '0000',
      pollInterval: Number.isInteger(options?.pollInterval) === true ? Math.min(300, Math.max(2, options.pollInterval)) : 5,
      discoveryInterval:
        Number.isInteger(options?.discoveryInterval) === true ? Math.min(3600, Math.max(30, options.discoveryInterval)) : 60,
      includeApplications: options?.includeApplications === true,
      includeChannels: options?.includeChannels === true,
    },
    devices: devices
      .filter((device) => typeof device?.host === 'string' && device.host.trim() !== '')
      .map((device) => ({
        host: device.host.trim(),
        name: typeof device?.name === 'string' && device.name.trim() !== '' ? device.name.trim() : undefined,
        psk: typeof device?.psk === 'string' && device.psk !== '' ? device.psk : undefined,
        includeApplications:
          device?.includeApplications === true || device?.includeApplications === false
            ? device.includeApplications
            : options?.includeApplications === true,
        includeChannels:
          device?.includeChannels === true || device?.includeChannels === false
            ? device.includeChannels
            : options?.includeChannels === true,
        exclude: device.exclude === true,
      })),
  };

  if (processed.options.autoDiscover === false && processed.devices.length === 0) {
    log?.warn?.('Automatic discovery is disabled and no Sony TVs are configured');
  }
  return processed;
}
