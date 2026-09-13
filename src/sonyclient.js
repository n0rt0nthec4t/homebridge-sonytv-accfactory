// Sony ScalarWebAPI Client
// Part of homebridge-sonytv-accfactory
//
// Handles authenticated local communication with Sony BRAVIA televisions and
// converts raw ScalarWebAPI responses into HomeKit-ready device data.
//
// Responsibilities:
// - Send JSON-RPC requests through the shared fetchWrapper()
// - Send IRCC remote-control commands
// - Read power, input, volume, system, application, tuner, and remote data
// - Optionally enumerate tuner channels and installed applications
// - Normalise raw responses into one immutable device snapshot
//
// Notes:
// - Unsupported endpoints do not prevent other television capabilities loading
// - System information is required because it supplies the stable accessory identity
//
// Code version 2026.09.11
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { URL } from 'node:url';

// Import our modules
import { fetchWrapper, scaleValue } from './utils.js';

// Define the Sony service, method, parameters, and API version used to build a
// complete television snapshot. Each entry is passed directly to request().
const REQUESTS = {
  power: ['system', 'getPowerStatus', [''], '1.0'],
  activeInput: ['avContent', 'getPlayingContentInfo', [''], '1.0'],
  volume: ['audio', 'getVolumeInformation', [''], '1.0'],
  system: ['system', 'getSystemInformation', [''], '1.0'],
  externalInputs: ['avContent', 'getCurrentExternalInputsStatus', [''], '1.0'],
  tuners: ['avContent', 'getSourceList', [{ scheme: 'tv' }], '1.0'],
  applications: ['appControl', 'getApplicationList', [''], '1.0'],
  remote: ['system', 'getRemoteControllerInfo', [''], '1.0'],
};

// Poll only state that can change during normal television use. Identity,
// inputs, applications, channels, and remote codes belong to initial inventory.
const STATUS_REQUESTS = ['power', 'activeInput', 'volume'];

// Map Sony input icon names to the common input types used by Television.
// Multiple Sony names can describe the same physical HomeKit input type.
const INPUT_TYPES = {
  HDMI: 'HDMI',
  CEC: 'HDMI',
  COMPONENT: 'COMPONENT',
  COMPONENTD: 'COMPONENT',
  SVIDEO: 'SVIDEO',
  COMPOSITE: 'COMPOSITE',
  WIFIDISPLAY: 'SCREENCAST',
  TUNERDEVICE: 'TUNER',
  TUNER: 'TUNER',
  TV: 'TUNER',
};

// Return one value from a successful Promise.allSettled() result. Unsupported
// Sony endpoints resolve to undefined so the rest of a snapshot can continue.
function resultValue(result, index = 0) {
  return result?.status === 'fulfilled' ? result.value?.[index] : undefined;
}

// Select the first usable Sony value from a list of identity fallbacks.
function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim();
}

export default class SonyClient {
  constructor(host, psk, { timeout = 5000, retryAttempts = 3 } = {}) {
    // Set and validate the host through the same path used after rediscovery.
    this.setHost(host);
    this.psk = String(psk ?? '');
    this.timeout = timeout;
    this.retryAttempts = Number.isInteger(retryAttempts) === true && retryAttempts > 0 ? retryAttempts : 3;
    this.nextRequestId = 1;
  }

  setHost(host) {
    // Accept a simple hostname/IP while retaining explicitly configured HTTPS.
    // SSDP can call this again when a television moves to another address.
    let value = String(host ?? '').trim();
    if (value === '') {
      throw new TypeError('TV host is required');
    }

    let url = new URL(value.includes('://') === true ? value : 'http://' + value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('TV host must use HTTP or HTTPS');
    }

    this.baseUrl = url.origin;
  }

  async request(service, method, params = [''], version = '1.0', extraHeaders = {}) {
    // Sony uses JSON-RPC-style bodies over HTTP POST for both reads and writes.
    let response = await fetchWrapper(
      'post',
      new URL('/sony/' + service, this.baseUrl).href,
      {
        headers: { 'X-Auth-PSK': this.psk, ...extraHeaders },
        timeout: this.timeout,
        // Retry read-only requests after transient network/server failures.
        // Commands remain single-attempt to avoid repeating user actions.
        retry: method.startsWith('get') === true ? this.retryAttempts : 1,
      },
      { method, params, version, id: this.nextRequestId++ },
    );

    // Sony reports JSON-RPC failures inside an otherwise successful HTTP reply.
    // Validate that every response contains the result array expected by callers.
    let body = await response.json();
    if (Array.isArray(body?.error) === true) {
      throw new Error('Sony API ' + method + ' failed (' + body.error.join(': ') + ')');
    }
    if (Array.isArray(body?.result) === false) {
      throw new Error('Sony API ' + method + ' returned an invalid response');
    }
    return body.result;
  }

  async sendIrcc(code) {
    // Remote-control commands use Sony's SOAP IRCC endpoint rather than the
    // JSON-RPC interface used for television status and control operations.
    let body = [
      '<?xml version="1.0"?>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ',
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
      '<s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">',
      '<IRCCCode>' + code + '</IRCCCode>',
      '</u:X_SendIRCC></s:Body></s:Envelope>',
    ].join('');

    // SOAPAction identifies the IRCC operation and the PSK authenticates the
    // request in the same way as the JSON-RPC endpoints.
    let response = await fetchWrapper(
      'post',
      new URL('/sony/IRCC', this.baseUrl).href,
      {
        headers: {
          'Content-Type': 'text/xml; charset=UTF-8',
          SOAPAction: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
          'X-Auth-PSK': this.psk,
        },
        timeout: this.timeout,
      },
      body,
    );
    return response;
  }

  // Set the television power state using Sony's system service.
  setPower(power) {
    return this.request('system', 'setPowerStatus', [{ status: power === true }]);
  }

  // Select a physical input, tuner channel, or application by its Sony URI.
  setInput(uri) {
    return this.request('avContent', 'setPlayContent', [{ uri }]);
  }

  // HomeKit supplies relative volume changes, which Sony represents as strings.
  changeVolume(increment) {
    return this.request('audio', 'setAudioVolume', [{ target: 'speaker', volume: increment === true ? '+1' : '-1' }]);
  }

  // Set the mute state for the television's audio output.
  setMute(mute) {
    return this.request('audio', 'setAudioMute', [{ status: mute === true }]);
  }

  async status({ inputs = [] } = {}) {
    // A regular status poll deliberately avoids the much heavier capability
    // inventory performed by snapshot(). Preserve fields whose request failed
    // so one unavailable endpoint cannot replace valid state with a default.
    let results = await this.#readRequests(STATUS_REQUESTS);
    if (Object.values(results).every((result) => result.status === 'rejected') === true) {
      throw results.power?.reason ?? new Error('Sony TV did not return status information');
    }

    let deviceData = { online: true };
    let power = resultValue(results.power);
    if (typeof power === 'object' && power !== null) {
      deviceData.power = String(power.status ?? 'standby').toUpperCase() === 'ACTIVE';
    }

    let active = resultValue(results.activeInput);
    if (typeof active === 'object' && active !== null) {
      let knownUris = new Set(inputs.map((input) => input?.uri).filter((uri) => typeof uri === 'string' && uri !== ''));
      deviceData.activeInput = {
        input: knownUris.has(active.source) === true ? active.source : (active.uri ?? ''),
        source: String(active.uri ?? ''),
      };
    }

    let speaker = (resultValue(results.volume) ?? []).find((entry) => String(entry.target).toUpperCase() === 'SPEAKER');
    if (speaker !== undefined) {
      deviceData.volume = Math.round(scaleValue(speaker.volume, speaker.minVolume, speaker.maxVolume, 0, 100));
      deviceData.mute = speaker.mute === true;
    }

    return deviceData;
  }

  async snapshot({ includeApplications = false, includeChannels = false } = {}) {
    // Read independent endpoints concurrently so unsupported optional features
    // do not hide power, volume, or other capabilities that remain available.
    let requestNames = Object.keys(REQUESTS).filter((key) => key !== 'applications' || includeApplications === true);
    let results = await this.#readRequests(requestNames);

    // System information provides the identity fields required to create a
    // HomeKitDevice, so a snapshot cannot be used when this request fails.
    let system = resultValue(results.system);
    if (typeof system !== 'object' || system === null) {
      throw results.system?.reason ?? new Error('Sony TV did not return system information');
    }

    let inputs = [];

    // Sony can return the same URI through more than one endpoint. Preserve the
    // first definition so HomeKit receives one stable service for each input.
    let addInput = (input) => {
      if (typeof input?.uri === 'string' && input.uri !== '' && inputs.some((existing) => existing.uri === input.uri) === false) {
        inputs.push(input);
      }
    };

    for (let input of resultValue(results.externalInputs) ?? []) {
      // Sony prefixes some icon names with a category. HomeKit only needs the
      // final icon component mapped to the plugin's common input type.
      let icon = String(input.icon ?? '')
        .split(':')
        .at(-1)
        .toUpperCase();
      addInput({
        uri: input.uri,
        title: String(input.title ?? 'Input').replace('/', ' - '),
        label: String(input.label ?? ''),
        type: INPUT_TYPES[icon] ?? 'OTHER',
        hidden: false,
      });
    }

    // Add the television's available tuner sources before optionally expanding
    // each source into its individual TV and radio channels.
    let tuners = resultValue(results.tuners) ?? [];
    for (let tuner of tuners) {
      // Only expose tuner schemes with a useful HomeKit display name.
      let title = {
        'TV:DVBT': 'Digital Tuner',
        'TV:ANALOG': 'Analog Tuner',
        'TV:DVBC': 'Cable Tuner',
        'TV:DVBS': 'Satellite Tuner',
      }[String(tuner.source).toUpperCase()];
      if (title !== undefined) {
        addInput({ uri: tuner.source, title, label: '', type: 'TUNER', hidden: false });
      }
    }

    if (includeChannels === true) {
      // Channel listing uses API version 1.2 and is independent for each tuner,
      // allowing one unsupported source to fail without hiding the others.
      let channelResults = await Promise.allSettled(
        tuners.map((tuner) => this.request('avContent', 'getContentList', [{ source: tuner.source, stIx: 0 }], '1.2')),
      );
      channelResults.forEach((result) => {
        for (let channel of resultValue(result) ?? []) {
          let mediaType = String(channel.programMediaType ?? '').toUpperCase();
          if (mediaType === 'TV' || mediaType === 'RADIO') {
            addInput({
              uri: channel.uri,
              title: String(channel.title ?? channel.dispNum ?? 'Channel'),
              label: String(channel.dispNum ?? ''),
              type: mediaType === 'TV' ? 'CHANNEL' : 'RADIO',
              hidden: false,
            });
          }
        }
      });
    }

    if (includeApplications === true) {
      // Applications use their launch URI as an input so they can be selected
      // from the same HomeKit input list as physical sources and channels.
      for (let application of resultValue(results.applications) ?? []) {
        addInput({
          uri: application.uri,
          title: String(application.title ?? 'Application'),
          label: '',
          type: 'APPLICATION',
          hidden: false,
        });
      }
    }

    // Select the television speaker from Sony's possible audio targets and
    // reconcile the currently playing source with the input list built above.
    let speaker = (resultValue(results.volume) ?? []).find((entry) => String(entry.target).toUpperCase() === 'SPEAKER');
    let active = resultValue(results.activeInput) ?? {};
    let activeUri = inputs.some((input) => input.uri === active.source) === true ? active.source : (active.uri ?? '');

    // Convert Sony's remote command list into a name-to-IRCC-code lookup used by
    // HomeKit remote key events. The command list is the second returned result.
    let remoteCommands = Object.fromEntries(
      (resultValue(results.remote, 1) ?? [])
        .filter((entry) => typeof entry?.name === 'string' && entry.name !== '' && typeof entry?.value === 'string' && entry.value !== '')
        .map((entry) => [entry.name.toUpperCase(), entry.value]),
    );

    // Return a plain, serialisable object suitable for HomeKitDevice storage.
    // Missing optional values receive stable defaults and Sony's volume range is
    // converted to HomeKit's zero-to-one-hundred scale.
    return {
      serialNumber: firstNonEmpty(system.serial, system.macAddr, this.baseUrl),
      softwareVersion: firstNonEmpty(system.generation, 'Unknown').replaceAll('_', '.'),
      description: firstNonEmpty(system.name, system.model, 'Sony TV'),
      manufacturer: 'Sony',
      model: firstNonEmpty(system.model, 'BRAVIA'),
      host: this.baseUrl,
      macAddress: String(system.macAddr ?? '').toUpperCase(),
      power: String(resultValue(results.power)?.status ?? 'standby').toUpperCase() === 'ACTIVE',
      activeInput: { input: activeUri, source: String(active.uri ?? '') },
      volume: speaker !== undefined ? Math.round(scaleValue(speaker.volume, speaker.minVolume, speaker.maxVolume, 0, 100)) : 0,
      mute: speaker?.mute === true,
      inputs,
      remoteCommands,
      online: true,
    };
  }

  async #readRequests(requestNames) {
    // Keep concurrent request orchestration shared by the full inventory and
    // lightweight status paths while retaining each result's endpoint name.
    let entries = requestNames.map((key) => [key, REQUESTS[key]]).filter(([, request]) => request !== undefined);
    let settled = await Promise.allSettled(entries.map(([, request]) => this.request(...request)));
    return Object.fromEntries(entries.map(([key], index) => [key, settled[index]]));
  }
}
