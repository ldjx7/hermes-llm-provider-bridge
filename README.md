# Hermes LLM Provider Bridge

OpenAI-compatible local provider bridge for Hermes. It exposes a stable `/v1` API and routes every request through the currently active global profile.

This project is unofficial and is not affiliated with Anthropic, OpenAI, NousResearch, Hermes, or Codex.

The important property is that profile switching is global. A user or admin can switch the active profile once, and every later request uses that profile until it is changed again.

## Flow

```text
Hermes request
  -> http://127.0.0.1:18777/v1
  -> bridge checks active profile from state file
  -> bridge sends structured prompt to configured CLI backend
  -> bridge returns OpenAI-compatible chat completion
```

For tool use, the bridge does not execute tools. It asks the backend model to return structured JSON tool intent, validates it against the current Hermes `tools` list, and returns OpenAI `tool_calls` so Hermes can execute its own tools.

The bridge serializes provider calls by default (`maxConcurrentRequests: 1`). This avoids multiple expensive CLI processes racing each other and keeps global profile switching predictable.

## API

```text
GET  /v1/models
POST /v1/chat/completions

GET  /admin/profiles
GET  /admin/active
POST /admin/switch
```

If `BRIDGE_ADMIN_TOKEN` or `adminToken` is configured, all `/admin/*` endpoints require:

```text
Authorization: Bearer <token>
```

Switch profile over HTTP:

```bash
curl -s -X POST http://127.0.0.1:18777/admin/switch \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $BRIDGE_ADMIN_TOKEN" \
  -d '{"profile":"claude-sonnet"}'
```

Switch profile with the CLI:

```bash
node src/cli.js use claude-sonnet --config bridge.config.json
node src/cli.js current --config bridge.config.json
node src/cli.js profiles --config bridge.config.json
node src/cli.js probe "你好，请回复一句话" --config bridge.config.json
```

`probe` runs a real chat completion through the currently active profile. Use it before pointing Hermes at the bridge.

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
API mode: Chat Completions
Model: hermes-bridge
```

## Model Routing

`GET /v1/models` returns an OpenAI-compatible model list. The bridge exposes two kinds of model ids:

- `hermes-bridge`: stable alias that routes to the current active profile
- profile names such as `claude-opus` and `claude-sonnet`: direct routes that bypass active profile switching

For example:

```bash
curl -s http://127.0.0.1:18777/v1/models
```

returns model ids like:

```text
hermes-bridge
claude-opus
claude-sonnet
mock
```

Call the active profile through the stable alias:

```json
{
  "model": "hermes-bridge",
  "messages": [{ "role": "user", "content": "hello" }]
}
```

Call a specific profile directly:

```json
{
  "model": "claude-sonnet",
  "messages": [{ "role": "user", "content": "hello" }]
}
```

This lets Hermes either keep one fixed model (`hermes-bridge`) or show multiple concrete models at the same time.

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

Each profile owns a backend command and the model mapping exposed to Hermes. Keep the exposed model id stable, such as `hermes-bridge`, then switch the active profile behind it.

```json
{
  "stateFile": "./bridge.state.json",
  "defaultProfile": "claude-opus",
  "maxConcurrentRequests": 1,
  "profiles": {
    "claude-opus": {
      "provider": "cli-json",
      "configDir": "/profiles/claude-max",
      "repairRetries": 1,
      "models": [{ "id": "hermes-bridge", "backendModel": "opus" }],
      "command": "claude",
      "args": ["--model", "{{backendModel}}", "--print", "{{prompt}}", "--output-format", "json"]
    }
  }
}
```

The CLI backend must print JSON that looks like one of these:

```json
{"type":"final","content":"answer text"}
```

```json
{"type":"tool_calls","tool_calls":[{"name":"run_shell","arguments":{"cmd":"pwd"}}]}
```

If the backend prints invalid JSON, `repairRetries` controls how many times the bridge retries with a repair prompt. Set it to `0` to fail immediately.

`POST /v1/chat/completions` supports both normal JSON responses and basic OpenAI-compatible SSE when the request includes `"stream": true`.

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
