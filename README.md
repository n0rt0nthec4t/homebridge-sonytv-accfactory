# homebridge-sonytv-accfactory

A dynamic Homebridge platform for Sony BRAVIA Android and Google TVs that use Sony's ScalarWebAPI.

## Features

- Power, current input, input switching, volume up/down, and mute
- Apple TV Remote navigation and media commands through Sony IRCC
- Physical inputs and TV tuners
- Optional application and channel inputs
- Optional SSDP discovery, plus manual host configuration
- Multiple TVs with a default or per-TV pre-shared key
- Dynamic platform accessories backed by the shared `HomeKitDevice` module

## TV setup

On each TV, enable remote control over the network, select **Pre-Shared Key** authentication, and configure the same key used by this plugin. Enabling remote start/network standby lets the TV receive network commands while it is in standby.

Install the plugin through the Homebridge UI and add the `SonyTVAccfactory` platform. Automatic discovery is enabled by default. The default key is `0000` for compatibility with the original accessory, but it should be changed on both the TV and in Homebridge.

Example configuration:

```json
{
  "platform": "SonyTVAccfactory",
  "name": "Sony TVs",
  "options": {
    "autoDiscover": true,
    "psk": "change-me",
    "pollInterval": 5,
    "includeApplications": false,
    "includeChannels": false
  },
  "devices": [
    {
      "name": "Living Room TV",
      "host": "192.168.1.50",
      "psk": "a-different-key",
      "includeApplications": true
    }
  ]
}
```

Manual entries are useful when multicast discovery is unavailable. They also act as per-TV overrides when the same host is discovered automatically.
The optional `name` value labels an override in the plugin settings only; the HomeKit television name comes from the TV.

Inputs are discovered once during startup and are not changed while Homebridge is running. The plugin rebuilds up to 85 inputs on restart in a deterministic order: physical inputs, tuners, applications, then channels, sorted within each group by Sony URI.

## Development

The shared base module is a Git submodule. Clone with submodules, or initialise it after cloning:

```sh
git submodule update --init --recursive
npm install
npm run check
```

Requires Node.js 22 or newer and Homebridge 1.11.4 or newer.
