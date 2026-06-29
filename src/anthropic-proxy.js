import crypto from "node:crypto";
import http from "node:http";

import { HttpError } from "./errors.js";

const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = 18778;
const PROXY_TOKEN_PLACEHOLDER = "PROXY_MANAGED";

export function createLocalAnthropicProxy({ config }) {
  return {
    async inject({ method, url, body, headers = {} }) {
      return await handleProxyRequest(config, {
        method,
        url,
        headers,
        body: body || ""
      });
    },

    async nodeHandler(req, res) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        const result = await handleProxyRequest(config, {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString()
        });
        res.statusCode = result.status;
        for (const [key, value] of Object.entries(result.headers)) {
          res.setHeader(key, value);
        }
        res.end(result.body);
      });
    }
  };
}

export async function startLocalAnthropicProxy(config) {
  if (!localAnthropicProxyEnabled(config)) return null;

  const app = createLocalAnthropicProxy({ config });
  const proxyConfig = localAnthropicProxyConfig(config);
  const host = proxyConfig.host || DEFAULT_PROXY_HOST;
  const port = Number(proxyConfig.port ?? DEFAULT_PROXY_PORT);
  const server = http.createServer((req, res) => {
    app.nodeHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  proxyConfig.__origin = localAnthropicProxyOrigin(config, address?.port);
  console.log(`Local Anthropic proxy listening on ${proxyConfig.__origin}`);
  return server;
}

export function localAnthropicProxyEnv(config, model) {
  if (!localAnthropicProxyEnabled(config)) return {};

  const proxyConfig = localAnthropicProxyConfig(config);
  const routeModel = model?.backendModel || model?.id;
  if (!routeModel) return {};
  const mapped = findProxyModel(proxyConfig, routeModel);
  if (!mapped) return {};

  const env = {
    ANTHROPIC_BASE_URL: localAnthropicProxyOrigin(config),
    ANTHROPIC_AUTH_TOKEN: proxyConfig.authTokenPlaceholder || PROXY_TOKEN_PLACEHOLDER
  };

  const family = claudeModelFamily(routeModel);
  const displayName = mapped?.backendModel || routeModel;
  if (family) {
    env[`ANTHROPIC_DEFAULT_${family}_MODEL`] = routeModel;
    env[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`] = displayName;
  } else {
    env.ANTHROPIC_MODEL = routeModel;
  }
  return env;
}

export function localAnthropicProxyEnabled(config) {
  return Boolean(localAnthropicProxyConfig(config)?.enabled);
}

function localAnthropicProxyConfig(config) {
  return config.localAnthropicProxy || config.anthropicProxy;
}

function localAnthropicProxyOrigin(config, actualPort) {
  const proxyConfig = localAnthropicProxyConfig(config) || {};
  if (proxyConfig.__origin) return proxyConfig.__origin;
  const host = connectHost(proxyConfig.host || DEFAULT_PROXY_HOST);
  const port = Number(actualPort ?? proxyConfig.port ?? DEFAULT_PROXY_PORT);
  return `http://${host}:${port}`;
}

async function handleProxyRequest(config, request) {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      assertProxyAuthorized(config, request);
      return await messagesCreate(config, parseJsonBody(request));
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(200, {
        data: (localAnthropicProxyConfig(config).models || []).map((model) => ({
          id: model.id,
          type: "model",
          display_name: model.backendModel || model.id
        }))
      });
    }
    return json(404, anthropicError("Not found", "not_found_error"));
  } catch (error) {
    const status = error.statusCode || 500;
    const type = error.code || "api_error";
    return json(status, anthropicError(error.message || "Unexpected proxy error", type));
  }
}

function assertProxyAuthorized(config, request) {
  const proxyConfig = localAnthropicProxyConfig(config);
  if (proxyConfig.requireAuth === false) return;

  const expected = proxyConfig.authTokenPlaceholder || PROXY_TOKEN_PLACEHOLDER;
  const token = bearerToken(request.headers)
    || headerValue(request.headers, "x-api-key")
    || headerValue(request.headers, "api-key");
  if (token === expected) return;

  throw new HttpError(401, "Unauthorized", "authentication_error");
}

async function messagesCreate(config, body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object", "invalid_request_error");
  }
  if (!body.model || typeof body.model !== "string") {
    throw new HttpError(400, "Request body must include model", "invalid_request_error");
  }
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "Request body must include messages", "invalid_request_error");
  }

  const proxyConfig = localAnthropicProxyConfig(config);
  const model = findProxyModel(proxyConfig, body.model);
  if (!model) {
    throw new HttpError(400, `Model "${body.model}" is not available`, "invalid_request_error");
  }

  const upstreamResponse = await callOpenAIChat(proxyConfig, model, body);
  const response = anthropicMessageResponse(body, upstreamResponse);
  if (body.stream) {
    return eventStream(200, streamAnthropicMessage(response));
  }
  return json(200, response);
}

async function callOpenAIChat(proxyConfig, model, body) {
  const baseUrl = proxyConfig.baseUrl || proxyConfig.upstream?.baseUrl;
  if (!baseUrl) {
    throw new HttpError(400, "localAnthropicProxy is missing baseUrl", "invalid_request_error");
  }

  const apiKey = proxyConfig.apiKey
    || (proxyConfig.apiKeyEnv ? process.env[proxyConfig.apiKeyEnv] : undefined)
    || proxyConfig.upstream?.apiKey;
  const controller = new AbortController();
  const timeoutMs = proxyConfig.timeoutMs || 120000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(proxyConfig.headers || {})
      },
      body: JSON.stringify(openAIChatRequest(model, body)),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new HttpError(response.status, `OpenAI upstream returned ${message}`, "api_error");
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new HttpError(504, `OpenAI upstream timed out after ${timeoutMs}ms`, "api_error");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `OpenAI upstream failed: ${error.message}`, "api_error");
  } finally {
    clearTimeout(timeout);
  }
}

function openAIChatRequest(model, request) {
  const body = {
    model: model.backendModel || model.id,
    messages: anthropicToOpenAIMessages(request)
  };

  copyOptional(body, request, [
    "metadata",
    "stop",
    "temperature",
    "top_p",
    "user"
  ]);

  if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || {}
      }
    }));
  }
  if (request.tool_choice?.type === "none") body.tool_choice = "none";
  if (request.tool_choice?.type === "auto") body.tool_choice = "auto";
  return body;
}

function anthropicToOpenAIMessages(request) {
  const messages = [];
  if (request.system !== undefined) {
    messages.push({ role: "system", content: contentText(request.system) });
  }
  for (const message of request.messages || []) {
    messages.push({
      role: message.role,
      content: contentText(message.content)
    });
  }
  return messages;
}

function anthropicMessageResponse(request, payload) {
  const message = payload.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new HttpError(502, "OpenAI upstream returned no assistant message", "api_error");
  }

  const usage = payload.usage || {};
  const response = {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    }
  };

  const toolCalls = normalizeOpenAIToolCalls(message.tool_calls);
  if (toolCalls.length > 0) {
    response.stop_reason = "tool_use";
    response.content.push(...toolCalls.map((call) => ({
      type: "tool_use",
      id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
      name: call.name,
      input: call.arguments
    })));
    return response;
  }

  response.content.push({ type: "text", text: openAIContentText(message.content) });
  return response;
}

function normalizeOpenAIToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call) => call?.type === "function" && call.function?.name)
    .map((call) => ({
      name: call.function.name,
      arguments: parseToolArguments(call.function.arguments)
    }));
}

function parseToolArguments(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === "object") return argumentsValue;
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return {};
  }
}

function streamAnthropicMessage(response) {
  const text = response.content.find((part) => part.type === "text")?.text || "";
  return [
    sse("message_start", {
      type: "message_start",
      message: { ...response, content: [] }
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text }
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: { output_tokens: response.usage.output_tokens }
    }),
    sse("message_stop", { type: "message_stop" })
  ].join("");
}

function findProxyModel(proxyConfig, requestedModel) {
  return (proxyConfig.models || []).find((model) => model.id === requestedModel);
}

function claudeModelFamily(model) {
  const lower = String(model || "").toLowerCase();
  if (lower.includes("fable")) return "FABLE";
  if (lower.includes("haiku")) return "HAIKU";
  if (lower.includes("opus")) return "OPUS";
  if (lower.includes("sonnet")) return "SONNET";
  return undefined;
}

function contentText(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return JSON.stringify(part);
    }).filter(Boolean).join("\n");
  }
  return JSON.stringify(content);
}

function openAIContentText(content) {
  return contentText(content);
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function copyOptional(target, source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

function parseJsonBody(request) {
  if (!request.body) return undefined;
  const contentType = request.headers["content-type"] || request.headers["Content-Type"] || "";
  if (!contentType.includes("application/json")) return undefined;
  try {
    return JSON.parse(request.body);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_request_error");
  }
}

function bearerToken(headers) {
  const authorization = headerValue(headers, "authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function headerValue(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

function connectHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function json(status, value) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  };
}

function eventStream(status, body) {
  return {
    status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    },
    body
  };
}

function sse(event, value) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function anthropicError(message, type) {
  return {
    type: "error",
    error: { type, message }
  };
}
