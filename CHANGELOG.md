# Changelog

All notable changes to this project will be documented in this file.

The format follows a simple versioned changelog. This project uses semantic versioning.

## [0.1.6] - 2026-06-24

### Fixed

- Pass default Claude Code prompts through stdin instead of argv to avoid `spawn E2BIG` when requests include large tool results or conversation context.
- Return `413 provider_input_too_large` when configured stdin input exceeds the bridge limit before starting the provider command.

## [0.1.5] - 2026-06-24

### Added

- Optional provider API key enforcement for `/v1/*` endpoints through `BRIDGE_API_KEY`, `apiKey`, `providerApiKey`, or `apiKeys`.
- Compatibility for upstream gateways that require an API key field: when no provider API key is configured, arbitrary caller-supplied API keys are accepted.

## [0.1.4] - 2026-06-24

### Fixed

- Retry CLI provider output repair when the provider requests a tool that Hermes did not advertise in the current request.
- Include the current request's available tool names in repair prompts so the provider can choose a valid tool or return a final answer.

## [0.1.3] - 2026-06-24

### Fixed

- Include stored Responses input/output history when `previous_response_id` is used.
- Treat object-form `tool_choice: { "type": "none" }` as disabled tool use.

## [0.1.2] - 2026-06-24

### Fixed

- Preserve Anthropic Messages content blocks such as `tool_use` and `tool_result` when building backend context.
- Prevent Hermes tool results from being dropped before they reach the backend model.

## [0.1.1] - 2026-06-24

### Added

- Anthropic-compatible `POST /v1/messages`.
- Anthropic `tool_use` content blocks for tool intent.
- Basic Anthropic Messages SSE support for `stream: true`.

## [0.1.0] - 2026-06-23

### Added

- OpenAI-compatible `GET /v1/models`.
- OpenAI-compatible `GET /v1/models/{model}`.
- OpenAI-compatible `POST /v1/chat/completions`.
- OpenAI-compatible `POST /v1/responses`.
- In-memory `GET /v1/responses/{response_id}` and `DELETE /v1/responses/{response_id}`.
- In-memory `GET /v1/responses/{response_id}/input_items`.
- Responses API `function_call` output items for tool intent.
- Global active profile switching through CLI and admin HTTP endpoints.
- `mock` and `cli-json` provider backends.
- OpenAI `tool_calls` conversion for Hermes tool execution.
- Admin token support through `BRIDGE_ADMIN_TOKEN` or `adminToken`.
- Provider request serialization with `maxConcurrentRequests`.
- CLI JSON repair retry with `repairRetries`.
- Basic server-sent events support for `stream: true`.
- Dockerfile and example bridge config.
- Docker Compose example with Claude Code config mount.
- `probe` command for validating the active backend.

### Changed

- Default model discovery reads Claude Code `settings.json`.
- `GET /v1/models` returns configured Claude model names.
- Chat completions and Responses requests require an explicit listed model.
- Requested model names are passed directly to `claude --model`.
- Docker deployments only require mounting Claude Code config by default.
