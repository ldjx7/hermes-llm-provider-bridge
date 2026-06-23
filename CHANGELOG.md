# Changelog

All notable changes to this project will be documented in this file.

The format follows a simple versioned changelog. This project uses semantic versioning once tagged releases begin.

## [0.1.2] - 2026-06-23

### Added

- Expose all profile names through `GET /v1/models`.
- Route direct model requests such as `claude-opus` and `claude-sonnet` to matching profiles.
- Keep `hermes-bridge` as the stable alias for the active profile.

## [0.1.1] - 2026-06-23

### Changed

- Docker deployments no longer require mounting bridge config by default.
- The Docker entrypoint creates `/config/bridge.config.json` from the built-in example when missing.
- Compose defaults to mounting only Claude Code config.

## [0.1.0] - 2026-06-23

### Added

- OpenAI-compatible `GET /v1/models`.
- OpenAI-compatible `POST /v1/chat/completions`.
- Global active profile switching through CLI and admin HTTP endpoints.
- `mock` and `cli-json` provider backends.
- OpenAI `tool_calls` conversion for Hermes tool execution.
- Admin token support through `BRIDGE_ADMIN_TOKEN` or `adminToken`.
- Provider request serialization with `maxConcurrentRequests`.
- CLI JSON repair retry with `repairRetries`.
- Basic server-sent events support for `stream: true`.
- Dockerfile and example bridge config.
- `probe` command for validating the active backend.
