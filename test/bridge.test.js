import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../src/app.js";
import { switchProfile, getActiveProfileName } from "../src/config-store.js";
import { normalizeCliResult } from "../src/openai.js";
import { probeActiveProfile } from "../src/probe.js";

async function fixtureConfig() {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-"));
  const stateFile = path.join(dir, "state.json");
  const configFile = path.join(dir, "bridge.config.json");
  const callsFile = path.join(dir, "calls.jsonl");
  const config = {
    stateFile,
    defaultProfile: "claude-opus",
    profiles: {
      "claude-opus": {
        provider: "mock",
        ownedBy: "local",
        models: [{ id: "hermes-bridge", backendModel: "opus" }],
        mockResponse: { type: "final", content: "opus response" }
      },
      "claude-sonnet": {
        provider: "mock",
        ownedBy: "local",
        models: [{ id: "hermes-bridge", backendModel: "sonnet" }],
        mockResponse: {
          type: "tool_calls",
          tool_calls: [
            { name: "run_shell", arguments: { cmd: "pwd" } }
          ]
        }
      }
    },
    test: { callsFile }
  };
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return { config, configFile, callsFile };
}

async function request(app, method, pathname, body, headers = {}) {
  const response = await app.inject({
    method,
    url: pathname,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    }
  });
  return {
    status: response.status,
    headers: response.headers,
    body: response.body ? parseResponseBody(response.body, response.headers) : undefined
  };
}

function parseResponseBody(body, headers) {
  if (headers?.["content-type"] === "text/event-stream") return body;
  return JSON.parse(body);
}

test("models endpoint exposes the globally active profile", async () => {
  const { config } = await fixtureConfig();
  const app = createApp({ config });

  let response = await request(app, "GET", "/v1/models");
  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].id, "hermes-bridge");

  await switchProfile(config, "claude-sonnet");
  response = await request(app, "GET", "/v1/models");
  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].id, "hermes-bridge");
  assert.equal(response.body.data[0].owned_by, "local");
});

test("admin switch updates global profile state for later requests", async () => {
  const { config } = await fixtureConfig();
  const app = createApp({ config });

  let response = await request(app, "GET", "/admin/active");
  assert.equal(response.body.profile, "claude-opus");

  response = await request(app, "POST", "/admin/switch", { profile: "claude-sonnet" });
  assert.equal(response.status, 200);
  assert.equal(response.body.profile, "claude-sonnet");
  assert.equal(await getActiveProfileName(config), "claude-sonnet");
});

test("admin endpoints require bearer token when configured", async () => {
  const { config } = await fixtureConfig();
  config.adminToken = "secret";
  const app = createApp({ config });

  let response = await request(app, "GET", "/admin/active");
  assert.equal(response.status, 401);

  response = await request(app, "GET", "/admin/active", undefined, {
    authorization: "Bearer secret"
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.profile, "claude-opus");
});

test("chat completions uses active profile and returns final content", async () => {
  const { config, callsFile } = await fixtureConfig();
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, "opus response");
  assert.equal(response.body.choices[0].finish_reason, "stop");

  const calls = await readFile(callsFile, "utf8");
  assert.match(calls, /"profile":"claude-opus"/);
});

test("chat completions converts model tool intent into OpenAI tool_calls", async () => {
  const { config } = await fixtureConfig();
  await switchProfile(config, "claude-sonnet");
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: "where am I?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "run_shell",
          parameters: {
            type: "object",
            required: ["cmd"],
            properties: { cmd: { type: "string" } }
          }
        }
      }
    ]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].finish_reason, "tool_calls");
  assert.equal(response.body.choices[0].message.content, null);
  assert.equal(response.body.choices[0].message.tool_calls[0].function.name, "run_shell");
  assert.equal(response.body.choices[0].message.tool_calls[0].function.arguments, "{\"cmd\":\"pwd\"}");
});

test("chat completions can return OpenAI-compatible SSE for stream requests", async () => {
  const { config } = await fixtureConfig();
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    stream: true,
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.match(response.body, /^data: /);
  assert.match(response.body, /"object":"chat.completion.chunk"/);
  assert.match(response.body, /data: \[DONE\]/);
});

test("chat completions rejects tool calls that are not in the Hermes tool list", async () => {
  const { config } = await fixtureConfig();
  await switchProfile(config, "claude-sonnet");
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: "where am I?" }],
    tools: []
  });

  assert.equal(response.status, 502);
  assert.match(response.body.error.message, /not available/);
});

test("normalizeCliResult extracts structured bridge JSON from Claude JSON output", () => {
  const normalized = normalizeCliResult(JSON.stringify({
    type: "result",
    result: "{\"type\":\"final\",\"content\":\"hello\"}"
  }));

  assert.deepEqual(normalized, { type: "final", content: "hello" });
});

test("cli-json retries once with a repair prompt when provider JSON is invalid", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-cli-"));
  const attemptsFile = path.join(dir, "attempts.txt");
  const config = {
    stateFile: path.join(dir, "state.json"),
    defaultProfile: "repairing-cli",
    profiles: {
      "repairing-cli": {
        provider: "cli-json",
        command: process.execPath,
        args: [path.resolve("fixtures/fake-cli.js")],
        env: { FAKE_CLI_ATTEMPTS_FILE: attemptsFile },
        repairRetries: 1,
        models: [{ id: "hermes-bridge", backendModel: "fake" }]
      }
    }
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, "repaired");
  assert.equal(await readFile(attemptsFile, "utf8"), "2");
});

test("provider requests are serialized by the global request queue", async () => {
  const { config } = await fixtureConfig();
  config.maxConcurrentRequests = 1;
  config.profiles["claude-opus"].mockDelayMs = 40;
  const app = createApp({ config });

  const startedAt = Date.now();
  await Promise.all([
    request(app, "POST", "/v1/chat/completions", {
      model: "hermes-bridge",
      messages: [{ role: "user", content: "one" }]
    }),
    request(app, "POST", "/v1/chat/completions", {
      model: "hermes-bridge",
      messages: [{ role: "user", content: "two" }]
    })
  ]);

  assert.ok(Date.now() - startedAt >= 70);
});

test("probe active profile runs a chat completion through the active backend", async () => {
  const { config } = await fixtureConfig();

  const result = await probeActiveProfile(config, "hello");

  assert.equal(result.profile, "claude-opus");
  assert.equal(result.model, "hermes-bridge");
  assert.equal(result.message.content, "opus response");
});
