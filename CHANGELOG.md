# Change Log

All notable changes to `homebridge-sonytv-accfactory` are documented in this file.  
This project adheres to [Semantic Versioning](http://semver.org/).

## v0.0.2 (Unreleased)

### Fixes

- Fixed runtime imports so the shared `HomeKitDevice` implementation resolves from its flattened `dist/HomeKitDevice.js` location
- Fixed package tests to exercise the built distribution layout used by Homebridge

### Improvements

- Aligned configuration UI grouping and wording with Daikin using Device Settings, Device Overrides, and Options
- Moved Sony status polling into the core, which pushes UPDATE messages to televisions like Denon and Daikin
- Added a per-TV override to exclude selected televisions from automatic discovery

### Maintenance

- Prevented parent formatting, linting, and test discovery from modifying or running files inside the `HomeKitDevice` submodule
- Replaced the local HTTP helper with the shared `fetchWrapper` submodule
- Used `fetchWrapper.POST` for Sony JSON-RPC and IRCC requests and the wrapper integration test
- Updated Homebridge plugin discovery keywords

### Dependency Updates

- Updated `HomeKitDevice` from `2026.09.12` to `2026.10.05`
- Updated `fetchWrapper` from `2026.09.17` to `2026.09.21`
- Updated `@homebridge/hap-nodejs` from `2.2.2` to `2.2.3`
- Updated `@types/node` from `26.5.0` to `26.5.1`
- Updated `rimraf` from `6.0.0` to `6.1.3`

## v0.0.1 (2026/09/15)

### Initial Release

- Migrated the standalone HAP-NodeJS accessory factory to a Homebridge dynamic platform.
- Added optional SSDP discovery and manual TV configuration.
- Added per-TV pre-shared keys and optional application/channel inputs.
- Imported the shared `HomeKitDevice` base module.
- Reused the Nest-style `fetchWrapper` instead of adding Axios.
- Preserved power, input, volume, mute, and remote-control support.
- Published televisions as independent external accessories and removed legacy bridged cache entries during migration.
- Rebuilt at most 85 startup-only television inputs in deterministic type and Sony URI order.
