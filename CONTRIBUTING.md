# Contributing

Thanks for considering a contribution.

This project is intentionally small: an OpenAI-compatible HTTP bridge that routes Hermes provider requests to globally switchable CLI profiles such as Claude Code or Codex.

## Development

Requirements:

- Node.js 22 or newer
- GitHub CLI for release and repository workflows
- Claude Code or another CLI backend only when testing real provider calls

Run the test suite:

```bash
npm test
```

Run the bridge locally:

```bash
cp bridge.config.example.json bridge.config.json
node src/server.js --config bridge.config.json
```

Probe the active profile:

```bash
node src/cli.js probe "Reply with one short sentence." --config bridge.config.json
```

## Pull Requests

Before opening a pull request:

- Keep changes focused.
- Add or update tests for behavior changes.
- Run `npm test`.
- Do not commit local credentials, profile state, or generated config files.
- Document new config fields in `README.md` and `bridge.config.example.json`.

## Design Boundaries

- The bridge should not execute Hermes tools itself.
- The bridge may translate model intent into OpenAI-compatible `tool_calls`.
- Hermes remains responsible for executing tools and feeding results back into the model loop.
- CLI authentication belongs to the user's mounted profile/config directory, not the Docker image.

## Commit Style

Use short, imperative commit messages, for example:

```text
add admin token support
document docker profile mounts
```
