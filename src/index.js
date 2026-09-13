// Plugin Entry Point
// Part of homebridge-sonytv-accfactory
//
// Registers the SonyTVAccfactory dynamic platform and initialises the shared
// HomeKitDevice metadata used for accessory identity and lifecycle management.
//
// Responsibilities:
// - Validate the Homebridge API object
// - Configure shared plugin and platform identifiers
// - Register the platform implementation from system.js
//
// Code version 2026.09.10
// Mark Hulskamp
'use strict';

// Import our modules
import SonyTVAccfactory from './system.js';
import HomeKitDevice from './HomeKitDevice/HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-sonytv-accfactory';
HomeKitDevice.PLATFORM_NAME = 'SonyTVAccfactory';
// HomeKitDevice.LOGGER will be set by the system class constructor

export default (api) => {
  // Validate Homebridge API object
  if (typeof api?.registerPlatform !== 'function') {
    throw new Error('SonyTVAccfactory: Invalid Homebridge API object - registerPlatform method not found');
  }

  // Register our platform with Homebridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, SonyTVAccfactory);
};
