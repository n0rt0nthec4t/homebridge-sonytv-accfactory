# Changelog

## 0.1.0

- Migrated the standalone HAP-NodeJS accessory factory to a Homebridge dynamic platform.
- Added optional SSDP discovery and manual TV configuration.
- Added per-TV pre-shared keys and optional application/channel inputs.
- Imported the shared `HomeKitDevice` base module.
- Reused the Nest-style `fetchWrapper` instead of adding Axios.
- Preserved power, input, volume, mute, and remote-control support.
- Published televisions as independent external accessories and removed legacy bridged cache entries during migration.
- Rebuilt at most 85 startup-only television inputs in deterministic type and Sony URI order.
