import crypto from "node:crypto";

import { HttpError } from "./errors.js";

export function modelsResponse(modelsOrProfile) {
  const models = Array.isArray(modelsOrProfile) ? modelsOrProfile : modelsOrProfile.models || [];
  const profile = Array.isArray(modelsOrProfile) ? undefined : modelsOrProfile;
  return {
    object: "list",
    data: models.map((model) => modelResponse(model, profile))
  };
}

export function modelResponse(model, profile) {
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: model.ownedBy || profile?.ownedBy || profile?.provider || "bridge"
  };
}

export function normalizeCliResult(stdout) {
  const parsed = parseJsonOutput(stdout);
  if (parsed?.type === "result" && typeof parsed.result === "string") {
    return parseJsonOutput(parsed.result);
  }
  if (parsed?.result && typeof parsed.result === "object") {
    return parsed.result;
  }
  return parsed;
}

export function chatCompletionResponse(request, modelResult) {
  const normalized = normalizeModelResult(modelResult);
  const base = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  if (normalized.type === "final") {
    base.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: normalized.content || ""
      },
      finish_reason: "stop"
    });
    return base;
  }

  const toolCalls = validateToolCalls(request, normalized.tool_calls || []);
  base.choices.push({
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: toolCalls.map((call) => ({
        id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments)
        }
      }))
    },
    finish_reason: "tool_calls"
  });
  return base;
}

export function streamChatCompletionResponse(completion) {
  const choice = completion.choices[0];
  const message = choice.message;
  const chunkBase = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model
  };

  if (message.tool_calls) {
    return [
      sse({
        ...chunkBase,
        choices: [{
          index: 0,
          delta: { role: "assistant", tool_calls: message.tool_calls },
          finish_reason: null
        }]
      }),
      sse({
        ...chunkBase,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      }),
      "data: [DONE]\n\n"
    ].join("");
  }

  return [
    sse({
      ...chunkBase,
      choices: [{
        index: 0,
        delta: { role: "assistant", content: message.content || "" },
        finish_reason: null
      }]
    }),
    sse({
      ...chunkBase,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }]
    }),
    "data: [DONE]\n\n"
  ].join("");
}

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function normalizeModelResult(modelResult) {
  if (!modelResult || typeof modelResult !== "object") {
    throw new HttpError(502, "Provider returned an empty or invalid result", "bad_provider_result");
  }
  if (modelResult.type === "final") {
    return { type: "final", content: String(modelResult.content ?? "") };
  }
  if (modelResult.type === "tool_calls") {
    return { type: "tool_calls", tool_calls: modelResult.tool_calls || [] };
  }
  throw new HttpError(502, `Provider returned unsupported result type "${modelResult.type}"`, "bad_provider_result");
}

function validateToolCalls(request, toolCalls) {
  if (request.tool_choice === "none") {
    throw new HttpError(502, "Provider returned tool calls while tool_choice is none", "invalid_tool_call");
  }
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new HttpError(502, "Provider returned tool_calls without any calls", "invalid_tool_call");
  }

  const schemas = new Map((request.tools || [])
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => [tool.function.name, tool.function.parameters || {}]));

  return toolCalls.map((call) => {
    if (!call?.name || !schemas.has(call.name)) {
      throw new HttpError(502, `Provider requested tool "${call?.name}" which is not available`, "invalid_tool_call");
    }
    const args = normalizeArguments(call.arguments);
    validateBasicSchema(call.name, args, schemas.get(call.name));
    return { name: call.name, arguments: args };
  });
}

function normalizeArguments(argumentsValue) {
  if (argumentsValue === undefined || argumentsValue === null) return {};
  if (typeof argumentsValue === "string") {
    const parsed = parseJsonOutput(argumentsValue);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(502, "Tool arguments must be a JSON object", "invalid_tool_call");
    }
    return parsed;
  }
  if (typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
    return argumentsValue;
  }
  throw new HttpError(502, "Tool arguments must be a JSON object", "invalid_tool_call");
}

function validateBasicSchema(toolName, args, schema) {
  if (!schema || schema.type !== "object") return;
  for (const required of schema.required || []) {
    if (!(required in args)) {
      throw new HttpError(502, `Provider omitted required argument "${required}" for tool "${toolName}"`, "invalid_tool_call");
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = schema.properties?.[key];
    if (!expected?.type) continue;
    if (!matchesType(value, expected.type)) {
      throw new HttpError(502, `Provider returned invalid type for argument "${key}" of tool "${toolName}"`, "invalid_tool_call");
    }
    if (expected.enum && !expected.enum.includes(value)) {
      throw new HttpError(502, `Provider returned invalid enum value for argument "${key}" of tool "${toolName}"`, "invalid_tool_call");
    }
  }
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new HttpError(502, "Provider returned no JSON output", "bad_provider_result");
  }
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(text.slice(first, last + 1));
    }
    throw new HttpError(502, "Provider returned output that is not valid JSON", "bad_provider_result");
  }
}
