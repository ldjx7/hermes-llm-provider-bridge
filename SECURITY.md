# Security Policy

## Supported Versions

Security fixes target the latest released version.

## Reporting a Vulnerability

Please do not open public issues for sensitive vulnerabilities.

Use GitHub private vulnerability reporting if it is enabled for this repository. If it is not available, open a minimal public issue that asks for a maintainer contact path without disclosing exploit details.

Include:

- Affected version or commit.
- Reproduction steps.
- Impact.
- Whether credentials, local profile data, or command execution are involved.

## Security Model

This project is a local bridge. It accepts OpenAI-compatible HTTP requests and invokes configured CLI backends.

Important boundaries:

- The bridge does not execute Hermes tools itself.
- Admin endpoints should be protected with `BRIDGE_ADMIN_TOKEN` when exposed beyond a trusted local process.
- CLI credentials must be provided by user-managed profile directories or environment variables.
- Do not bake Claude Code, Codex, OpenAI, Anthropic, or GitHub credentials into Docker images.
- Treat mounted profile directories as sensitive secrets.

## Hardening Checklist

- Bind to `127.0.0.1` for local desktop use.
- Set `BRIDGE_ADMIN_TOKEN` when using `/admin/*` endpoints.
- Keep `maxConcurrentRequests` low for CLI backends.
- Mount only the profile directories required by the active backend.
- Avoid exposing the bridge directly to the public internet.
