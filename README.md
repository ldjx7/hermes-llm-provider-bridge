# Hermes LLM Provider Bridge

OpenAI-compatible local provider bridge for Hermes. It exposes Claude Code CLI as a local `/v1` provider.

This project is unofficial and is not affiliated with Anthropic, OpenAI, NousResearch, Hermes, or Codex.

By default, the bridge discovers available models from the mounted Claude Code `settings.json` and calls `claude --model <requested-model>`.

## Flow

```text
Hermes request
  -> http://127.0.0.1:18777/v1
  -> bridge reads Claude Code settings from /profiles/claude-max/settings.json
  -> bridge sends a structured prompt to claude --model <requested-model>
  -> bridge returns OpenAI-compatible chat completion or response
```

For tool use, the bridge does not execute tools. It asks the backend model to return structured JSON tool intent, validates it against the current Hermes `tools` list, and returns OpenAI `tool_calls` or Responses `function_call` output items so Hermes can execute its own tools.

The bridge serializes provider calls by default (`maxConcurrentRequests: 1`). This avoids multiple expensive CLI processes racing each other and keeps global profile switching predictable.

## API

```text
GET  /v1/models
GET  /v1/models/{model}
POST /v1/chat/completions
POST /v1/responses
GET  /v1/responses/{response_id}
DELETE /v1/responses/{response_id}
GET  /v1/responses/{response_id}/input_items

GET  /admin/profiles
GET  /admin/active
POST /admin/switch
```

The `/admin/*` profile endpoints are retained for advanced profile-based configs. They are not required by the default Claude settings mode.

If `BRIDGE_ADMIN_TOKEN` or `adminToken` is configured, all `/admin/*` endpoints require:

```text
Authorization: Bearer <token>
```

CLI helpers:

```bash
node src/cli.js probe "你好，请回复一句话" --config bridge.config.json
```

`probe` runs a real chat completion through the configured backend. Use it before pointing Hermes at the bridge.

## Local Run

```bash
cp bridge.config.example.json bridge.config.json
export BRIDGE_ADMIN_TOKEN="$(openssl rand -hex 24)"
node src/server.js --config bridge.config.json
```

Hermes provider settings:

```text
API base URL: http://127.0.0.1:18777/v1
API key: test
API mode: Chat Completions or Responses
Model: claude-sonnet-4-6
```

## Model Routing

`GET /v1/models` returns an OpenAI-compatible model list derived from Claude Code settings:

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "claude-sonnet-4-6"
  },
  "model": "sonnet"
}
```

For example:

```bash
curl -s http://127.0.0.1:18777/v1/models
```

returns model ids like:

```text
claude-sonnet-4-6
```

Call a listed model directly:

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "hello" }]
}
```

The bridge executes:

```bash
claude --model claude-sonnet-4-6
```

Chat completions require an explicit `model` value. In the default Claude settings mode, the requested model must be one of the ids returned by `GET /v1/models`; hidden aliases such as `hermes-bridge` are not accepted.

## Responses API

`POST /v1/responses` accepts the same listed model ids:

```bash
curl -s http://127.0.0.1:18777/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "input": "请只回复一句中文：测试成功"
  }'
```

Text output is returned as a Responses `message` item with `output_text` content. Tool intent is returned as `function_call` output items:

```json
{
  "type": "function_call",
  "call_id": "call_...",
  "name": "run_shell",
  "arguments": "{\"cmd\":\"pwd\"}"
}
```

The bridge stores responses in memory when `store` is not `false`, so they can be read or deleted through `GET /v1/responses/{response_id}` and `DELETE /v1/responses/{response_id}` while the bridge process is running. Stored response inputs can be listed with `GET /v1/responses/{response_id}/input_items`. `stream: true` returns a basic Responses server-sent event stream.

## Docker

Build:

```bash
docker build -t hermes-bridge .
```

Published images are available from GitHub Container Registry after tagged releases:

```bash
docker pull ghcr.io/ldjx7/hermes-bridge:latest
docker pull ghcr.io/ldjx7/hermes-bridge:v0.1.0
```

Docker images are published only when a pushed tag points to a commit reachable from `main`. Each release publishes both the pushed tag and `latest`.

Tagged image builds install Claude Code during the Docker build. The release workflow disables Docker build cache and pulls the base image on every tagged build, so the Claude Code installer is fetched and run fresh each time.

Run with mounted Claude profile data:

```bash
docker run --rm -p 18777:18777 \
  -e BRIDGE_ADMIN_TOKEN="$(openssl rand -hex 24)" \
  -v "$HOME/.claude:/profiles/claude-max" \
  ghcr.io/ldjx7/hermes-bridge:latest
```

Docker Compose for Docker-network-only access:

```bash
export BRIDGE_ADMIN_TOKEN="$(openssl rand -hex 24)"
docker compose up -d
```

The image creates `/config/bridge.config.json` from the built-in example config when that file is not mounted. That means the default Docker and Compose deployments only require the Claude Code config mount.

The included `compose.yml` mounts:

- `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` to `/profiles/claude-max` for Claude Code config

It uses `expose: 18777` and does not publish host ports. Other containers on the `hermes-internal` network can use:

```text
http://bridge:18777/v1
```

If you want to customize bridge profiles or persist `bridge.state.json` across container recreation, mount a config directory explicitly:

```yaml
volumes:
  - ./config:/config
  - ${CLAUDE_CONFIG_DIR:-${HOME}/.claude}:/profiles/claude-max
```

If you want to build without installing Claude Code in the image:

```bash
docker build --build-arg INSTALL_CLAUDE=false -t hermes-bridge .
```

## Config Shape

The default config reads model names from mounted Claude Code settings and passes requested model names directly to Claude Code:

```json
{
  "maxConcurrentRequests": 1,
  "modelSource": "claude-settings",
  "claude": {
    "provider": "cli-json",
    "configDir": "/profiles/claude-max",
    "repairRetries": 1,
    "command": "claude",
    "args": ["--model", "{{backendModel}}", "--print", "{{prompt}}", "--output-format", "json"]
  }
}
```

Profile-based routing is still supported for advanced custom configs, but it is no longer the default Docker path.

The CLI backend must print JSON that looks like one of these:

```json
{"type":"final","content":"answer text"}
```

```json
{"type":"tool_calls","tool_calls":[{"name":"run_shell","arguments":{"cmd":"pwd"}}]}
```

If the backend prints invalid JSON, `repairRetries` controls how many times the bridge retries with a repair prompt. Set it to `0` to fail immediately.

`POST /v1/chat/completions` and `POST /v1/responses` support both normal JSON responses and basic OpenAI-compatible SSE when the request includes `"stream": true`.

## Test

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Please do not include credentials, local profile data, or generated state files in issues or pull requests.

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
