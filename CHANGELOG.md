# Changelog

All notable changes to this project will be documented in this file.

The format follows a simple versioned changelog. This project uses semantic versioning once tagged releases begin.

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
