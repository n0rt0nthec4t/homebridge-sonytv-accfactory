// Overall Sony TV communications and device management
// Part of homebridge-sonytv-accfactory
//
// Coordinates configuration, SSDP discovery, Sony API clients, cached Homebridge
// accessories, and HomeKit television instances.
//
// Responsibilities:
// - Restore and validate cached platform accessories
// - Inspect manually configured and automatically discovered TVs
// - Deduplicate devices using Sony's stable serial number
// - Apply global and per-TV configuration options
// - Poll mutable television state and push HomeKitDevice UPDATE messages
// - Serve command requests from tracked television modules
// - Create or update HomeKitDevice-backed Television instances
// - Release discovery, polling, and tracking resources during shutdown
//
// Notes:
// - Discovery candidates are authenticated before accessories are created
// - Missing SSDP replies never remove a previously known television
//
// Code version 2026.09.12
// Mark Hulskamp
'use strict';

// Import our modules
import { clearInterval, setInterval } from 'node:timers';

import { processConfig } from './config.js';
import { startDiscovery } from './discovery.js';
import HomeKitDevice from './HomeKitDevice.js';
import SonyClient from './sonyclient.js';
import Television from './television.js';

export default class SonyTVAccfactory {
  #browser; // Active SSDP discovery controller
  #shuttingDown = false; // Prevent new polling and publication during shutdown
  #configuredByHost = new Map(); // Manual configuration overrides, keyed by host
  #inFlight = new Map(); // Active inspection promises, keyed by host
  #trackedDevices = new Map(); // Television modules, clients, and snapshot options, keyed by serial number

  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    HomeKitDevice.LOGGER = log;
    this.config = processConfig(config, log);

    for (let device of this.config.devices) {
      try {
        let client = new SonyClient(device.host, device.psk ?? this.config.options.psk);
        this.#configuredByHost.set(client.baseUrl, device);
      } catch (error) {
        this?.log?.warn?.('Ignoring invalid Sony TV host "%s": %s', device.host, error.message);
      }
    }

    api?.on?.('didFinishLaunching', async () => {
      try {
        // Inspect configured televisions before optionally starting SSDP discovery.
        await Promise.allSettled(this.config.devices.map((device) => this.#setupTelevision(device.host, device)));

        if (this.config.options.autoDiscover === true && this.#shuttingDown === false) {
          this.#browser = startDiscovery({
            interval: this.config.options.discoveryInterval * 1000,
            onDevice: (candidate) => this.#handleDiscovered(candidate),
            onError: (error) => this?.log?.debug?.('Sony TV discovery error: %s', error.message),
          });
          this?.log?.info?.('Searching for Sony TVs using on local network every %d seconds', this.config.options.discoveryInterval);
        }
      } catch (error) {
        this?.log?.error?.('Sony TV startup failed: %s', error.message);
      }
    });

    api?.on?.('shutdown', async () => {
      this.#shuttingDown = true;
      for (let tracked of this.#trackedDevices.values()) {
        clearInterval(tracked.timer);
        tracked.timer = undefined;
      }
      this.#browser?.stop();
      this.#browser = undefined;
      // Drain network work before releasing accessory handlers and tracking.
      await Promise.allSettled([...this.#inFlight.values()]);
      await Promise.allSettled([...this.#trackedDevices.values()].map((tracked) => tracked.poll));
      await Promise.allSettled([...this.#trackedDevices.values()].map((tracked) => tracked.device.shutdown()));
      this.#inFlight.clear();
      this.#trackedDevices.clear();
    });
  }

  configureAccessory(accessory) {
    // Sony TVs are now independent external accessories and are recreated on
    // every launch. Remove any bridged accessory restored from an older version
    // so its UUID cannot conflict with the external publication.
    this?.log?.info?.('Removing legacy bridged accessory "%s" from cache', accessory.displayName);
    try {
      this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      // Empty
    }
  }

  async #handleDiscovered(candidate) {
    let host;
    try {
      host = new SonyClient(candidate.host, this.config.options.psk).baseUrl;
    } catch {
      return;
    }

    // A Homebridge installation normally tracks very few televisions, so a
    // direct lookup avoids maintaining a second, potentially stale host index.
    let trackedDevice = [...this.#trackedDevices.values()].find((device) => device.client.baseUrl === host);
    if (trackedDevice !== undefined) {
      return;
    }

    let overrides = this.#configuredByHost.get(host) ?? {};
    await this.#setupTelevision(host, overrides);
  }

  async #setupTelevision(host, overrides = {}) {
    if (this.#shuttingDown === true) {
      return;
    }

    let client;
    try {
      client = new SonyClient(host, overrides.psk ?? this.config.options.psk);
    } catch (error) {
      this?.log?.warn?.('Invalid Sony TV host "%s": %s', host, error.message);
      return;
    }

    let hostUrl = client.baseUrl;
    if (this.#inFlight.has(hostUrl) === true) {
      return this.#inFlight.get(hostUrl);
    }

    let operation = (async () => {
      let options = {
        includeApplications: overrides.includeApplications ?? this.config.options.includeApplications,
        includeChannels: overrides.includeChannels ?? this.config.options.includeChannels,
      };
      try {
        let deviceData = await client.snapshot(options);
        if (this.#shuttingDown === true) {
          return;
        }
        deviceData = {
          ...deviceData,
          description: HomeKitDevice.makeValidHKName(deviceData.description),
          inputs: deviceData.inputs.map((input) => ({ ...input, title: HomeKitDevice.makeValidHKName(input.title) })),
          includeApplications: options.includeApplications,
          includeChannels: options.includeChannels,
        };
        let serialNumber = deviceData.serialNumber;
        let trackedDevice = this.#trackedDevices.get(serialNumber);

        if (trackedDevice === undefined && overrides.exclude === true) {
          this?.log?.warn?.('Device "%s" is ignored due to it being marked as excluded', deviceData.description);
          return;
        }

        if (trackedDevice !== undefined) {
          trackedDevice.client.setHost(hostUrl);
          // Preserve configured data and immutable inputs if the same serial is
          // rediscovered at another host.
          await HomeKitDevice.message(trackedDevice.device.uuid, HomeKitDevice.UPDATE, {
            ...deviceData,
            description: trackedDevice.device.deviceData.description,
            inputs: trackedDevice.device.deviceData.inputs,
            includeApplications: trackedDevice.device.deviceData.includeApplications,
            includeChannels: trackedDevice.device.deviceData.includeChannels,
          });
          return trackedDevice.device;
        }

        let television = new Television(undefined, this.api, deviceData);
        trackedDevice = { device: television, client, timer: undefined, poll: undefined };

        // Route commands emitted by the television through its current client.
        HomeKitDevice.message(television.uuid, HomeKitDevice.SET, async (values) => {
          await this.#set(trackedDevice.client, values);
        });

        let added = await television.add({
          hapAccessoryName: 'Sony Television',
          hapCategory: this.api.hap.Categories.TELEVISION,
          enableHistory: false,
          externalPublish: true,
        });
        if (added !== true) {
          await television.remove();
          return;
        }

        this.#trackedDevices.set(serialNumber, trackedDevice);
        this.#startPolling(trackedDevice);
        this?.log?.debug?.('Sony TV "%s" found at %s', deviceData.description, hostUrl);
        return television;
      } catch (error) {
        this?.log?.warn?.('Unable to connect to Sony TV at %s: %s', hostUrl, error.message);
      }
    })().finally(() => this.#inFlight.delete(hostUrl));

    this.#inFlight.set(hostUrl, operation);
    return operation;
  }

  #startPolling(tracked) {
    if (this.#shuttingDown === true || tracked.timer !== undefined) {
      return;
    }

    // Match Denon and Daikin: each client is polled by the core independently.
    // A slow TV skips its next tick without blocking updates to other TVs.
    tracked.timer = setInterval(() => {
      if (this.#shuttingDown === true || tracked.poll !== undefined) {
        return;
      }
      tracked.poll = (async () => {
        let deviceData;
        try {
          deviceData = await tracked.client.status({ inputs: tracked.device.deviceData.inputs });
        } catch (error) {
          this?.log?.debug?.('Unable to poll Sony TV "%s": %s', tracked.device.deviceData.description, error.message);
          deviceData = { online: false };
        }
        // An in-flight request may finish after shutdown has stopped polling.
        if (this.#shuttingDown === false) {
          await HomeKitDevice.message(tracked.device.uuid, HomeKitDevice.UPDATE, deviceData);
        }
      })()
        .catch((error) => this?.log?.warn?.('Unable to update Sony TV: %s', error.message))
        .finally(() => {
          tracked.poll = undefined;
        });
      return tracked.poll;
    }, this.config.options.pollInterval * 1000);
    tracked.timer?.unref?.();
  }

  async #set(client, values) {
    if (typeof client !== 'object' || client === null || typeof values !== 'object' || values === null) {
      return;
    }

    if (values.command === 'setPower') {
      await client.setPower(values.value);
    }
    if (values.command === 'setInput') {
      await client.setInput(values.value);
    }
    if (values.command === 'changeVolume') {
      await client.changeVolume(values.value);
    }
    if (values.command === 'setMute') {
      await client.setMute(values.value);
    }
    if (values.command === 'sendIrcc') {
      await client.sendIrcc(values.value);
    }
  }
}
