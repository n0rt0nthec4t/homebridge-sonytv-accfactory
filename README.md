<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# SonyTV Accfactory

![npm](https://img.shields.io/npm/v/homebridge-sonytv-accfactory/latest?label=npm%40latest&color=%234CAF50)

</span>

A dynamic Homebridge platform for Sony BRAVIA Android and Google TVs that use Sony's ScalarWebAPI.

## Features

- Power, current input, input switching, volume up/down, and mute
- Apple TV Remote navigation and media commands through Sony IRCC
- Physical inputs and TV tuners
- Optional application and channel inputs
- Optional SSDP discovery, plus manual host configuration
- Multiple TVs with a default or per-TV pre-shared key
- Independently published television accessories backed by the shared `HomeKitDevice` module

## TV setup

On each TV, enable remote control over the network, select **Pre-Shared Key** authentication, and configure the same key used by this plugin. Enabling remote start/network standby lets the TV receive network commands while it is in standby.

Install the plugin through the Homebridge UI and add the `SonyTVAccfactory` platform. Automatic discovery is enabled by default. The default key is `0000` for compatibility with the original accessory, but it should be changed on both the TV and in Homebridge.

Each TV is published as an independent HomeKit accessory. Add each discovered TV separately in the Home app using the Homebridge pairing code.

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
Set `exclude` to `true` on an override to prevent that TV from being published, including when automatic discovery finds it.

The core polls each TV at `pollInterval` seconds and pushes reported state to its HomeKit accessory. Slow polls skip overlapping requests, and polling stops during shutdown. Configured TVs unavailable at startup are retried every `discoveryInterval` seconds, including when automatic discovery is disabled.

Inputs are discovered once during startup and are not changed while Homebridge is running. The plugin rebuilds up to 85 inputs on restart in a deterministic order: physical inputs, tuners, applications, then channels, sorted within each group by Sony URI.

## Development

The shared `HomeKitDevice` and `fetchWrapper` modules are Git submodules. Clone with submodules, or initialise them after cloning:

```sh
git submodule update --init --recursive
npm install
npm run check
```

Requires Node.js 22, 24, or 26 and either Homebridge 1.11.4 or newer in the 1.x series, or Homebridge 2.4.0 or newer in the 2.x series.
