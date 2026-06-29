import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalAnthropicProxy } from "../src/anthropic-proxy.js";
import { createApp } from "../src/app.js";
import { claudeProviderConfig } from "../src/claude-settings.js";
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

async function openAIUpstream(handler) {
  const errors = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const rawBody = Buffer.concat(chunks).toString();
        const body = rawBody ? JSON.parse(rawBody) : undefined;
        const result = handler({ req, body });
        res.statusCode = result.status || 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result.body));
      } catch (error) {
        errors.push(error);
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    assertNoErrors() {
      assert.deepEqual(errors, []);
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
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

test("default Claude settings provider sends prompts through stdin", () => {
  const provider = claudeProviderConfig({});

  assert.equal(provider.stdin, "{{prompt}}");
  assert.ok(!provider.args.includes("{{prompt}}"));
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

test("provider endpoints accept arbitrary API keys when no provider API key is configured", async () => {
  const { config } = await fixtureConfig();
  const app = createApp({ config });

  const response = await request(app, "GET", "/v1/models", undefined, {
    authorization: "Bearer sub2api-required-placeholder"
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.object, "list");
});

test("provider endpoints require the configured provider API key", async () => {
  const { config } = await fixtureConfig();
  config.apiKey = "provider-secret";
  const app = createApp({ config });

  let response = await request(app, "GET", "/v1/models");
  assert.equal(response.status, 401);

  response = await request(app, "GET", "/v1/models", undefined, {
    authorization: "Bearer wrong"
  });
  assert.equal(response.status, 401);

  response = await request(app, "GET", "/v1/models", undefined, {
    authorization: "Bearer provider-secret"
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.object, "list");
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

test("openai-chat provider calls an OpenAI-compatible upstream using settings credentials", async () => {
  const upstream = await openAIUpstream(({ req, body }) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer upstream-secret");
    assert.equal(body.model, "MiniMax-M3");
    assert.equal(body.messages[0].content, "hello");
    return {
      body: {
        id: "chatcmpl-upstream",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "upstream ok" },
          finish_reason: "stop"
        }]
      }
    };
  });

  try {
    const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-openai-"));
    const configDir = path.join(dir, "settings");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: upstream.origin,
        ANTHROPIC_AUTH_TOKEN: "upstream-secret"
      }
    }));
    const app = createApp({
      config: {
        defaultProfile: "minimax",
        profiles: {
          minimax: {
            provider: "openai-chat",
            ownedBy: "minimax",
            configDir,
            models: [{ id: "claude-opus-4-6", backendModel: "MiniMax-M3" }]
          }
        }
      }
    });

    const response = await request(app, "POST", "/v1/chat/completions", {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hello" }]
    });

    upstream.assertNoErrors();
    assert.equal(response.status, 200);
    assert.equal(response.body.model, "claude-opus-4-6");
    assert.equal(response.body.choices[0].message.content, "upstream ok");
  } finally {
    await upstream.close();
  }
});

test("openai-chat provider returns upstream tool calls without executing tools", async () => {
  const upstream = await openAIUpstream(({ body }) => {
    assert.equal(body.model, "MiniMax-M3");
    assert.equal(body.tools[0].function.name, "run_shell");
    return {
      body: {
        id: "chatcmpl-upstream-tool",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "run_shell",
                arguments: "{\"cmd\":\"pwd\"}"
              }
            }]
          },
          finish_reason: "tool_calls"
        }]
      }
    };
  });

  try {
    const app = createApp({
      config: {
        defaultProfile: "minimax",
        profiles: {
          minimax: {
            provider: "openai-chat",
            ownedBy: "minimax",
            baseUrl: upstream.baseUrl,
            apiKey: "direct-secret",
            models: [{ id: "claude-opus-4-6", backendModel: "MiniMax-M3" }]
          }
        }
      }
    });

    const response = await request(app, "POST", "/v1/chat/completions", {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "where am I?" }],
      tools: [{
        type: "function",
        function: {
          name: "run_shell",
          parameters: {
            type: "object",
            required: ["cmd"],
            properties: { cmd: { type: "string" } }
          }
        }
      }]
    });

    upstream.assertNoErrors();
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].finish_reason, "tool_calls");
    assert.equal(response.body.choices[0].message.tool_calls[0].function.name, "run_shell");
    assert.equal(response.body.choices[0].message.tool_calls[0].function.arguments, "{\"cmd\":\"pwd\"}");
  } finally {
    await upstream.close();
  }
});

test("local Anthropic proxy maps Claude routes to an OpenAI-compatible upstream", async () => {
  const originalApiKey = process.env.LOCAL_ANTHROPIC_PROXY_TEST_KEY;
  process.env.LOCAL_ANTHROPIC_PROXY_TEST_KEY = "upstream-secret";
  const upstream = await openAIUpstream(({ req, body }) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer upstream-secret");
    assert.equal(body.model, "gpt-5.4");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "You are concise.");
    assert.equal(body.messages[1].content, "hello");
    assert.equal(body.max_tokens, 128);
    return {
      body: {
        id: "chatcmpl-local-proxy",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "proxy ok" },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }
    };
  });

  try {
    const proxy = createLocalAnthropicProxy({
      config: {
        localAnthropicProxy: {
          enabled: true,
          baseUrl: upstream.baseUrl,
          apiKeyEnv: "LOCAL_ANTHROPIC_PROXY_TEST_KEY",
          models: [{ id: "claude-opus-4-8", backendModel: "gpt-5.4" }]
        }
      }
    });

    const response = await proxy.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "PROXY_MANAGED" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        system: "You are concise.",
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }]
      })
    });

    upstream.assertNoErrors();
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.type, "message");
    assert.equal(body.model, "claude-opus-4-8");
    assert.deepEqual(body.content, [{ type: "text", text: "proxy ok" }]);
    assert.equal(body.usage.input_tokens, 3);
    assert.equal(body.usage.output_tokens, 2);
  } finally {
    await upstream.close();
    if (originalApiKey === undefined) {
      delete process.env.LOCAL_ANTHROPIC_PROXY_TEST_KEY;
    } else {
      process.env.LOCAL_ANTHROPIC_PROXY_TEST_KEY = originalApiKey;
    }
  }
});

test("local Anthropic proxy rejects unconfigured model routes", async () => {
  const proxy = createLocalAnthropicProxy({
    config: {
      localAnthropicProxy: {
        enabled: true,
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "claude-opus-4-8", backendModel: "gpt-5.4" }]
      }
    }
  });

  const response = await proxy.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json", "x-api-key": "PROXY_MANAGED" },
    body: JSON.stringify({
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }]
    })
  });

  assert.equal(response.status, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /Model "gpt-5\.4" is not available/);
});

test("local Anthropic proxy requires the managed placeholder token by default", async () => {
  const proxy = createLocalAnthropicProxy({
    config: {
      localAnthropicProxy: {
        enabled: true,
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "claude-opus-4-8", backendModel: "gpt-5.4" }]
      }
    }
  });

  const response = await proxy.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }]
    })
  });

  assert.equal(response.status, 401);
  const body = JSON.parse(response.body);
  assert.equal(body.error.type, "authentication_error");
});

test("local Anthropic proxy returns bad_request for invalid JSON", async () => {
  const proxy = createLocalAnthropicProxy({
    config: {
      localAnthropicProxy: {
        enabled: true,
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "claude-opus-4-8", backendModel: "gpt-5.4" }]
      }
    }
  });

  const response = await proxy.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { "content-type": "application/json", authorization: "Bearer PROXY_MANAGED" },
    body: "{"
  });

  assert.equal(response.status, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.message, "Request body must be valid JSON");
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

test("responses include previous_response_id context for the backend model", async () => {
  const { config, callsFile } = await fixtureClaudeSettingsConfig({
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "claude-sonnet-4-6"
    }
  });
  const app = createApp({ config });

  const first = await request(app, "POST", "/v1/responses", {
    model: "claude-sonnet-4-6",
    input: "我的名字是梁杰"
  });

  const second = await request(app, "POST", "/v1/responses", {
    model: "claude-sonnet-4-6",
    previous_response_id: first.body.id,
    input: "我叫什么？"
  });

  assert.equal(second.status, 200);

  const calls = (await readFile(callsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messages.map((message) => message.role), [
    "user",
    "assistant",
    "user"
  ]);
  assert.equal(calls[1].messages[0].content, "我的名字是梁杰");
  assert.equal(calls[1].messages[1].content, "settings response");
  assert.equal(calls[1].messages[2].content, "我叫什么？");
});

test("responses rejects tool calls when object tool_choice is none", async () => {
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
    input: "hello",
    tool_choice: { type: "none" },
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

  assert.equal(response.status, 502);
  assert.match(response.body.error.message, /tool_choice is none/);
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

test("cli-json can pass prompt through stdin instead of argv", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-cli-stdin-"));
  const marker = `stdin-marker-${"x".repeat(10000)}`;
  const config = {
    stateFile: path.join(dir, "state.json"),
    defaultProfile: "stdin-cli",
    profiles: {
      "stdin-cli": {
        provider: "cli-json",
        command: process.execPath,
        args: [path.resolve("fixtures/fake-cli.js")],
        stdin: "{{prompt}}",
        env: {
          FAKE_CLI_MODE: "stdin-echo",
          FAKE_CLI_MARKER: marker
        },
        repairRetries: 0,
        models: [{ id: "hermes-bridge", backendModel: "fake" }]
      }
    }
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: marker }]
  });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.choices[0].message.content), {
    markerInStdin: true,
    markerInArgv: false
  });
});

test("cli-json injects local Anthropic proxy takeover environment", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-cli-proxy-env-"));
  const config = {
    stateFile: path.join(dir, "state.json"),
    localAnthropicProxy: {
      enabled: true,
      host: "127.0.0.1",
      port: 18778,
      baseUrl: "https://upstream.example/v1",
      apiKeyEnv: "UPSTREAM_API_KEY",
      models: [{ id: "claude-opus-4-8", backendModel: "gpt-5.4" }]
    },
    defaultProfile: "proxied-cli",
    profiles: {
      "proxied-cli": {
        provider: "cli-json",
        command: process.execPath,
        args: [path.resolve("fixtures/fake-cli.js")],
        env: { FAKE_CLI_MODE: "env-dump" },
        repairRetries: 0,
        models: [{ id: "hermes-model", backendModel: "claude-opus-4-8" }]
      }
    }
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-model",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body.choices[0].message.content), {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:18778",
    ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "gpt-5.4"
  });
});

test("cli-json leaves non-proxied backend models on their direct environment", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-cli-direct-env-"));
  const config = {
    stateFile: path.join(dir, "state.json"),
    localAnthropicProxy: {
      enabled: true,
      host: "127.0.0.1",
      port: 18778,
      baseUrl: "https://upstream.example/v1",
      apiKeyEnv: "UPSTREAM_API_KEY",
      models: [{ id: "claude-opus-4-8", backendModel: "gpt-5.4" }]
    },
    defaultProfile: "direct-cli",
    profiles: {
      "direct-cli": {
        provider: "cli-json",
        command: process.execPath,
        args: [path.resolve("fixtures/fake-cli.js")],
        env: {
          FAKE_CLI_MODE: "env-dump",
          ANTHROPIC_BASE_URL: "https://direct.example",
          ANTHROPIC_AUTH_TOKEN: "direct-token"
        },
        repairRetries: 0,
        models: [{ id: "direct-model", backendModel: "claude-sonnet-4-6" }]
      }
    }
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "direct-model",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(response.status, 200);
  const env = JSON.parse(response.body.choices[0].message.content);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://direct.example");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "direct-token");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, undefined);
});

test("cli-json rejects stdin prompts that exceed the configured stdin limit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-cli-stdin-limit-"));
  const config = {
    stateFile: path.join(dir, "state.json"),
    defaultProfile: "stdin-cli",
    profiles: {
      "stdin-cli": {
        provider: "cli-json",
        command: process.execPath,
        args: [path.resolve("fixtures/fake-cli.js")],
        stdin: "{{prompt}}",
        maxStdinBytes: 64,
        env: { FAKE_CLI_MODE: "stdin-echo" },
        repairRetries: 0,
        models: [{ id: "hermes-bridge", backendModel: "fake" }]
      }
    }
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: "this prompt is intentionally too large for the tiny test limit" }]
  });

  assert.equal(response.status, 413);
  assert.equal(response.body.error.type, "provider_input_too_large");
  assert.match(response.body.error.message, /stdin input exceeds/);
});

test("cli-json repairs tool calls that are not in the Hermes tool list", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-bridge-cli-tool-"));
  const attemptsFile = path.join(dir, "attempts.txt");
  const config = {
    stateFile: path.join(dir, "state.json"),
    defaultProfile: "repairing-cli",
    profiles: {
      "repairing-cli": {
        provider: "cli-json",
        command: process.execPath,
        args: [path.resolve("fixtures/fake-cli.js"), "{{prompt}}"],
        env: {
          FAKE_CLI_ATTEMPTS_FILE: attemptsFile,
          FAKE_CLI_MODE: "invalid-tool"
        },
        repairRetries: 1,
        models: [{ id: "hermes-bridge", backendModel: "fake" }]
      }
    }
  };
  const app = createApp({ config });

  const response = await request(app, "POST", "/v1/chat/completions", {
    model: "hermes-bridge",
    messages: [{ role: "user", content: "who won the latest CS2 major?" }],
    tools: [{
      type: "function",
      function: {
        name: "run_shell",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string" }
          },
          required: ["cmd"]
        }
      }
    }]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.choices[0].message.content, "repaired tool intent");
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
