// Sony BRAVIA HomeKit Television
// Part of homebridge-sonytv-accfactory
//
// Presents one Sony television through HomeKit's Television, TelevisionSpeaker,
// and linked InputSource services.
//
// Responsibilities:
// - Create and update HomeKit television and speaker services
// - Build a stable startup-only physical, tuner, application, and channel input list
// - Route HomeKit power, input, volume, mute, and remote commands
// - Apply state updates pushed by the core through HomeKitDevice
//
// Notes:
// - Input identifiers retain the CRC32 scheme used by the original accessory
// - Network commands are routed through the HomeKitDevice SET handler
// - Sony network access remains in the core and its HomeKitDevice SET handler
//
// Code version 2026.09.14
// Mark Hulskamp
'use strict';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { crc32 } from './utils.js';

export default class Television extends HomeKitDevice {
  static TYPE = 'television';
  static VERSION = '2026.09.14';
  static MAX_INPUTS = 85;

  static INPUT_TYPES = {
    HDMI: 'HDMI',
    COMPONENT: 'COMPONENT_VIDEO',
    SVIDEO: 'S_VIDEO',
    COMPOSITE: 'COMPOSITE_VIDEO',
    SCREENCAST: 'AIRPLAY',
    TUNER: 'TUNER',
    APPLICATION: 'APPLICATION',
    CHANNEL: 'OTHER',
    RADIO: 'OTHER',
    OTHER: 'OTHER',
  };

  // Produce the bounded input topology used to rebuild an external TV.
  static prepareInputs(inputs) {
    let priority = { TUNER: 1, APPLICATION: 2, CHANNEL: 3, RADIO: 3 };
    return [...(Array.isArray(inputs) ? inputs : [])]
      .sort((a, b) => {
        let order = (priority[a?.type] ?? 0) - (priority[b?.type] ?? 0);
        return order !== 0 ? order : String(a?.uri ?? '').localeCompare(String(b?.uri ?? ''), 'en');
      })
      .slice(0, Television.MAX_INPUTS);
  }

  televisionService = undefined; // HomeKit Television service
  speakerService = undefined; // HomeKit TelevisionSpeaker service
  inputServices = new Map(); // HomeKit InputSource services, keyed by Sony URI
  #restoreInputServices = false; // Cached TVs retain their existing HomeKit input topology

  constructor(accessory, api, deviceData) {
    // Reconstruct the same service order on every launch: physical inputs first,
    // then tuners, applications, and channels, with Sony URI as the stable key.
    super(accessory, api, { ...deviceData, inputs: Television.prepareInputs(deviceData?.inputs) });

    // Apple Home does not reliably reconcile Television inputs added or removed
    // after pairing. Only a newly created accessory may create input services.
    this.#restoreInputServices = accessory !== undefined;
  }

  // Class functions
  onAdd() {
    // Create the services and characteristic handlers used to expose this TV to HomeKit.
    // Setup television service if not already present on the accessory
    this.televisionService = this.addService(this.hap.Service.Television, this.deviceData.description, 1);
    this.televisionService.setPrimaryService();
    this.televisionService.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.deviceData.description);
    this.televisionService.updateCharacteristic(
      this.hap.Characteristic.SleepDiscoveryMode,
      this.hap.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    );
    this.televisionService.updateCharacteristic(this.hap.Characteristic.ClosedCaptions, this.hap.Characteristic.ClosedCaptions.DISABLED);

    // Setup television characteristics
    this.addCharacteristic(this.televisionService, this.hap.Characteristic.Active, {
      onSet: (value) => {
        return this.setPower(value);
      },
      onGet: () => {
        return this.deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    this.addCharacteristic(this.televisionService, this.hap.Characteristic.ActiveIdentifier, {
      onSet: (value) => {
        return this.setInput(value);
      },
      onGet: () => {
        return this.#identifierForUri(this.deviceData.activeInput?.input);
      },
    });

    this.addCharacteristic(this.televisionService, this.hap.Characteristic.RemoteKey, {
      onSet: (value) => {
        return this.sendRemoteKey(value);
      },
    });

    this.addCharacteristic(this.televisionService, this.hap.Characteristic.PowerModeSelection, {
      onSet: (value) => {
        return this.accessSettings(value);
      },
    });

    // Setup television speaker service if not already present on the accessory
    this.speakerService = this.addService(this.hap.Service.TelevisionSpeaker, '', 1);
    this.speakerService.updateCharacteristic(this.hap.Characteristic.Active, this.hap.Characteristic.Active.ACTIVE);
    this.speakerService.updateCharacteristic(this.hap.Characteristic.VolumeControlType, this.hap.Characteristic.VolumeControlType.ABSOLUTE);

    // Setup television speaker characteristics
    this.addCharacteristic(this.speakerService, this.hap.Characteristic.VolumeSelector, {
      onSet: (value) => {
        return this.setVolume(value);
      },
    });

    this.addCharacteristic(this.speakerService, this.hap.Characteristic.Mute, {
      onSet: (value) => {
        return this.setMute(value);
      },
      onGet: () => {
        return this.deviceData.mute === true;
      },
    });

    // Create inputs for a new TV, or restore references and handlers for the
    // stable InputSource services already cached by Homebridge.
    this.#setupInputs(this.deviceData.inputs);

    this.postSetupDetail('Host "%s"', this.deviceData.host, 'debug');
    this.postSetupDetail('%d television input(s)', this.deviceData.inputs.length);
  }

  onRemove() {
    // Remove every service created by this module and release their runtime references.
    this.inputServices.forEach((service) => this.removeService(service));
    this.inputServices.clear();
    this.removeService(this.televisionService);
    this.removeService(this.speakerService);
    this.televisionService = undefined;
    this.speakerService = undefined;
  }

  onUpdate(deviceData) {
    // Apply a complete device snapshot received through HomeKitDevice.
    if (
      typeof deviceData !== 'object' ||
      deviceData?.constructor !== Object ||
      this.televisionService === undefined ||
      this.speakerService === undefined
    ) {
      return;
    }

    // Update the television power state.
    this.televisionService.updateCharacteristic(
      this.hap.Characteristic.Active,
      deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );

    // Update the selected input when Sony reports a known input URI.
    let activeIdentifier = this.#identifierForUri(deviceData.activeInput?.input);
    if (activeIdentifier !== 0) {
      this.televisionService.updateCharacteristic(this.hap.Characteristic.ActiveIdentifier, activeIdentifier);
    }

    // Keep the television speaker state in sync with the television.
    this.speakerService.updateCharacteristic(
      this.hap.Characteristic.Active,
      deviceData.power === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );
    this.speakerService.updateCharacteristic(this.hap.Characteristic.Volume, deviceData.volume);
    this.speakerService.updateCharacteristic(this.hap.Characteristic.Mute, deviceData.mute);
  }

  async setPower(value) {
    // Translate HomeKit's Active value into Sony's boolean power state.
    let power = value === this.hap.Characteristic.Active.ACTIVE;
    if (power !== this.deviceData.power) {
      await this.set({ command: 'setPower', value: power });
    }
  }

  async setInput(value) {
    // Resolve HomeKit's numeric identifier back to the Sony input URI.
    let input = this.deviceData.inputs.find((candidate) => this.#identifierForUri(candidate.uri) === value);
    if (input !== undefined && input.uri !== this.deviceData.activeInput?.input) {
      await this.set({ command: 'setInput', value: input.uri });
    }
  }

  setVolume(value) {
    // Sony accepts relative speaker volume changes rather than a target level.
    return this.set({
      command: 'changeVolume',
      value: value === this.hap.Characteristic.VolumeSelector.INCREMENT,
    });
  }

  async setMute(value) {
    // Avoid sending a network command when the requested mute state is already active.
    let mute = value === true;
    if (mute !== this.deviceData.mute) {
      await this.set({ command: 'setMute', value: mute });
    }
  }

  accessSettings(value) {
    // HomeKit's settings action maps to Sony's Action Menu IRCC command.
    let code = this.deviceData.remoteCommands?.ACTIONMENU;
    if (value === this.hap.Characteristic.PowerModeSelection.SHOW && typeof code === 'string' && code !== '') {
      return this.set({ command: 'sendIrcc', value: code });
    }
  }

  #setupInputs(inputs = []) {
    // Television input topology is immutable after pairing. On restoration we
    // only recover known cached services; missing or new inputs are left alone.
    inputs.forEach((input) => {
      // Use the Sony URI as the stable runtime key and derive its HomeKit identifier.
      let identifier = this.#identifierForUri(input.uri);
      let subType = 'input-' + identifier;
      let service = this.accessory?.getServiceById?.(this.hap.Service.InputSource, subType);
      let name = HomeKitDevice.makeValidHKName(
        typeof input.label === 'string' && input.label !== '' ? input.title + ' - ' + input.label : input.title,
      );
      let hidden = input.hidden === true;

      if (service === undefined && this.#restoreInputServices === false) {
        // Create and link each input exactly once, before a new TV is paired.
        service = this.addService(this.hap.Service.InputSource, name, subType);
        this.televisionService?.addLinkedService(service);
        service.updateCharacteristic(this.hap.Characteristic.Name, name);
        service.updateCharacteristic(this.hap.Characteristic.Identifier, identifier);
        service.updateCharacteristic(
          this.hap.Characteristic.InputSourceType,
          this.hap.Characteristic.InputSourceType[Television.INPUT_TYPES[input.type] ?? 'OTHER'],
        );
        service.updateCharacteristic(this.hap.Characteristic.IsConfigured, this.hap.Characteristic.IsConfigured.CONFIGURED);
        service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, name);
        service.updateCharacteristic(
          this.hap.Characteristic.CurrentVisibilityState,
          hidden ? this.hap.Characteristic.CurrentVisibilityState.HIDDEN : this.hap.Characteristic.CurrentVisibilityState.SHOWN,
        );
        service.updateCharacteristic(
          this.hap.Characteristic.TargetVisibilityState,
          hidden ? this.hap.Characteristic.TargetVisibilityState.HIDDEN : this.hap.Characteristic.TargetVisibilityState.SHOWN,
        );
      }

      if (service !== undefined) {
        this.inputServices.set(input.uri, service);

        // Restore handlers without replacing names or visibility selected in Home.
        this.addCharacteristic(service, this.hap.Characteristic.ConfiguredName, {
          onSet: (value) => {
            let configuredName = HomeKitDevice.makeValidHKName(value);
            service.updateCharacteristic(this.hap.Characteristic.ConfiguredName, configuredName);
          },
        });

        this.addCharacteristic(service, this.hap.Characteristic.TargetVisibilityState, {
          onSet: (value) => {
            let isHidden = value === this.hap.Characteristic.TargetVisibilityState.HIDDEN;
            service.updateCharacteristic(
              this.hap.Characteristic.CurrentVisibilityState,
              isHidden ? this.hap.Characteristic.CurrentVisibilityState.HIDDEN : this.hap.Characteristic.CurrentVisibilityState.SHOWN,
            );
          },
        });
      }
    });
  }

  #identifierForUri(uri) {
    // HomeKit input identifiers are numeric, so derive a repeatable value from the Sony URI.
    if (typeof uri !== 'string' || uri === '') {
      return 0;
    }

    let identifier = crc32(uri);
    return identifier !== 0 ? identifier : 1;
  }

  sendRemoteKey(value) {
    // Translate HomeKit remote buttons into the command names advertised by the TV.
    let RemoteKey = this.hap.Characteristic.RemoteKey;
    let command = new Map([
      [RemoteKey.REWIND, 'REWIND'],
      [RemoteKey.FAST_FORWARD, 'FORWARD'],
      [RemoteKey.NEXT_TRACK, 'NEXT'],
      [RemoteKey.PREVIOUS_TRACK, 'PREV'],
      [RemoteKey.ARROW_UP, 'UP'],
      [RemoteKey.ARROW_DOWN, 'DOWN'],
      [RemoteKey.ARROW_LEFT, 'LEFT'],
      [RemoteKey.ARROW_RIGHT, 'RIGHT'],
      [RemoteKey.SELECT, 'CONFIRM'],
      [RemoteKey.BACK, 'RETURN'],
      [RemoteKey.EXIT, 'EXIT'],
      [
        RemoteKey.PLAY_PAUSE,
        typeof this.deviceData.remoteCommands?.PLAYPAUSE === 'string' && this.deviceData.remoteCommands.PLAYPAUSE !== ''
          ? 'PLAYPAUSE'
          : 'PLAY',
      ],
      [RemoteKey.INFORMATION, 'DISPLAY'],
    ]).get(value);
    let code = this.deviceData.remoteCommands?.[command];

    // Ignore buttons for which this TV did not advertise an IRCC code.
    if (typeof code === 'string' && code !== '') {
      return this.set({ command: 'sendIrcc', value: code });
    }
  }
}
