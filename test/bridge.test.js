import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function fixtureClaudeSettingsConfig(settings) {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-claude-"));
  const claudeConfigDir = path.join(dir, "claude");
  const callsFile = path.join(dir, "calls.jsonl");
  await mkdir(claudeConfigDir, { recursive: true });
  await writeFile(path.join(claudeConfigDir, "settings.json"), JSON.stringify(settings, null, 2));

  return {
    config: {
      modelSource: "claude-settings",
      claude: {
        provider: "mock",
        ownedBy: "claude-code",
        configDir: claudeConfigDir,
        mockResponse: { type: "final", content: "settings response" }
      },
      test: { callsFile }
    },
    callsFile
  };
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
  assert.deepEqual(response.body.data.map((model) => model.id), [
    "hermes-bridge",
    "claude-opus",
    "claude-sonnet"
  ]);

  await switchProfile(config, "claude-sonnet");
  response = await request(app, "GET", "/v1/models");
  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].id, "hermes-bridge");
  assert.equal(response.body.data[0].owned_by, "local");
});

test("models endpoint can derive available models from Claude settings", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    },
    model: "sonnet"
  });
  const app = createApp({ config });

  const response = await request(app, "GET", "/v1/models");

  assert.equal(response.status, 200);
  assert.equal(response.body.object, "list");
  assert.deepEqual(response.body.data.map((model) => model.id), ["claude-sonnet-4-6"]);
  assert.equal(response.body.data[0].object, "model");
  assert.equal(response.body.data[0].owned_by, "claude-code");
});

test("models endpoint can retrieve a single listed model", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "GET", "/v1/models/claude-sonnet-4-6");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    id: "claude-sonnet-4-6",
    object: "model",
    created: 0,
    owned_by: "claude-code"
  });
});

test("models endpoint returns not_found for an unlisted model", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "GET", "/v1/models/hermes-bridge");

  assert.equal(response.status, 404);
  assert.equal(response.body.error.type, "not_found");
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

test("chat completions can route directly to a named profile model", async () => {
  const { config, callsFile } = await fixtureConfig();
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "claude-sonnet",
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
  assert.equal(response.body.model, "claude-sonnet");
  assert.equal(response.body.choices[0].finish_reason, "tool_calls");

  const calls = await readFile(callsFile, "utf8");
  assert.match(calls, /"profile":"claude-sonnet"/);
});

test("chat completions can call a Claude settings model directly", async () => {
  const { config, callsFile } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    },
    model: "sonnet"
  });
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.model, "claude-sonnet-4-6");
  assert.equal(response.body.choices[0].message.content, "settings response");

  const calls = await readFile(callsFile, "utf8");
  assert.match(calls, /"backendModel":"claude-sonnet-4-6"/);
});

test("chat completions rejects unlisted aliases in Claude settings mode", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    },
    model: "sonnet"
  });
  const app = createApp({ config });

  const models = await request(app, "GET", "/v1/models");
  assert.deepEqual(models.body.data.map((model) => model.id), [
    "claude-opus-4-6",
    "claude-sonnet-4-6"
  ]);

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /not available/);
});

test("chat completions requires an explicit model", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /include model/);
});

test("responses create returns an OpenAI-compatible response object", async () => {
  const { config, callsFile } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/responses", {
    model: "claude-sonnet-4-6",
    instructions: "Reply briefly.",
    input: "hello"
  });

  assert.equal(response.status, 200);
  assert.match(response.body.id, /^resp_/);
  assert.equal(response.body.object, "response");
  assert.equal(response.body.status, "completed");
  assert.equal(response.body.model, "claude-sonnet-4-6");
  assert.equal(response.body.output[0].type, "message");
  assert.equal(response.body.output[0].role, "assistant");
  assert.deepEqual(response.body.output[0].content, [{
    type: "output_text",
    text: "settings response",
    annotations: []
  }]);

  const calls = await readFile(callsFile, "utf8");
  assert.match(calls, /"backendModel":"claude-sonnet-4-6"/);
  assert.match(calls, /"role":"system","content":"Reply briefly\."/);
  assert.match(calls, /"role":"user","content":"hello"/);
});

test("responses create returns function_call output without executing tools", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  config.claude.mockResponse = {
    type: "tool_calls",
    tool_calls: [
      { name: "run_shell", arguments: { cmd: "pwd" } }
    ]
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/responses", {
    model: "claude-sonnet-4-6",
    input: [{ role: "user", content: "where am I?" }],
    tools: [
      {
        type: "function",
        name: "run_shell",
        parameters: {
          type: "object",
          required: ["cmd"],
          properties: { cmd: { type: "string" } }
        }
      }
    ]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.output.length, 1);
  assert.equal(response.body.output[0].type, "function_call");
  assert.equal(response.body.output[0].name, "run_shell");
  assert.equal(response.body.output[0].arguments, "{\"cmd\":\"pwd\"}");
  assert.match(response.body.output[0].call_id, /^call_/);
});

test("responses can retrieve and delete stored responses", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const created = await request(app, "POST", "/v1/responses", {
    model: "claude-sonnet-4-6",
    input: "hello"
  });

  const fetched = await request(app, "GET", `/v1/responses/${created.body.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.id, created.body.id);

  const deleted = await request(app, "DELETE", `/v1/responses/${created.body.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, {
    id: created.body.id,
    object: "response",
    deleted: true
  });

  const missing = await request(app, "GET", `/v1/responses/${created.body.id}`);
  assert.equal(missing.status, 404);
});

test("responses can list stored input items", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const created = await request(app, "POST", "/v1/responses", {
    model: "claude-sonnet-4-6",
    input: "hello"
  });

  const response = await request(app, "GET", `/v1/responses/${created.body.id}/input_items`);

  assert.equal(response.status, 200);
  assert.equal(response.body.object, "list");
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].type, "message");
  assert.equal(response.body.data[0].role, "user");
  assert.deepEqual(response.body.data[0].content, [{
    type: "input_text",
    text: "hello"
  }]);
  assert.equal(response.body.first_id, response.body.data[0].id);
  assert.equal(response.body.last_id, response.body.data[0].id);
  assert.equal(response.body.has_more, false);
});

test("responses can return SSE for stream requests", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/responses", {
    model: "claude-sonnet-4-6",
    stream: true,
    input: "hello"
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.match(response.body, /event: response.created/);
  assert.match(response.body, /event: response.output_text.delta/);
  assert.match(response.body, /event: response.completed/);
  assert.match(response.body, /data: \[DONE\]/);
});

test("anthropic messages returns an Anthropic-compatible message", async () => {
  const { config, callsFile } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "claude-opus-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/messages", {
    model: "claude-opus-4-6",
    system: "Reply briefly.",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 128
  });

  assert.equal(response.status, 200);
  assert.match(response.body.id, /^msg_/);
  assert.equal(response.body.type, "message");
  assert.equal(response.body.role, "assistant");
  assert.equal(response.body.model, "claude-opus-4-6");
  assert.deepEqual(response.body.content, [{ type: "text", text: "settings response" }]);
  assert.equal(response.body.stop_reason, "end_turn");
  assert.equal(response.body.stop_sequence, null);
  assert.deepEqual(response.body.usage, { input_tokens: 0, output_tokens: 0 });

  const calls = await readFile(callsFile, "utf8");
  assert.match(calls, /"backendModel":"claude-opus-4-6"/);
  assert.match(calls, /"role":"system","content":"Reply briefly\."/);
  assert.match(calls, /"role":"user","content":"hello"/);
});

test("anthropic messages returns tool_use blocks without executing tools", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "claude-opus-4-6"
    }
  });
  config.claude.mockResponse = {
    type: "tool_calls",
    tool_calls: [
      { name: "run_shell", arguments: { cmd: "pwd" } }
    ]
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/messages", {
    model: "claude-opus-4-6",
    messages: [{ role: "user", content: "where am I?" }],
    max_tokens: 128,
    tools: [
      {
        name: "run_shell",
        input_schema: {
          type: "object",
          required: ["cmd"],
          properties: { cmd: { type: "string" } }
        }
      }
    ]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.stop_reason, "tool_use");
  assert.equal(response.body.content.length, 1);
  assert.equal(response.body.content[0].type, "tool_use");
  assert.match(response.body.content[0].id, /^toolu_/);
  assert.equal(response.body.content[0].name, "run_shell");
  assert.deepEqual(response.body.content[0].input, { cmd: "pwd" });
});

test("anthropic messages preserves tool result content for the backend model", async () => {
  const { config, callsFile } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "claude-opus-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/messages", {
    model: "claude-opus-4-6",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_search",
            name: "web_search",
            input: { query: "CS2 latest major champion" }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_search",
            content: "BLAST.tv Austin Major 2025 champion: Vitality"
          }
        ]
      }
    ],
    max_tokens: 128,
    tools: [
      {
        name: "web_search",
        input_schema: {
          type: "object",
          required: ["query"],
          properties: { query: { type: "string" } }
        }
      }
    ]
  });

  assert.equal(response.status, 200);

  const calls = await readFile(callsFile, "utf8");
  assert.match(calls, /CS2 latest major champion/);
  assert.match(calls, /BLAST\.tv Austin Major 2025 champion: Vitality/);
  assert.match(calls, /toolu_search/);
});

test("anthropic messages can return SSE for stream requests", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "claude-opus-4-6"
    }
  });
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/messages", {
    model: "claude-opus-4-6",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 128
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.match(response.body, /event: message_start/);
  assert.match(response.body, /event: content_block_delta/);
  assert.match(response.body, /event: message_stop/);
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

test("probe uses the exposed Claude settings model", async () => {
  const { config } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });

  const result = await probeActiveProfile(config, "hello");

  assert.equal(result.profile, "claude");
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.message.content, "settings response");
});
