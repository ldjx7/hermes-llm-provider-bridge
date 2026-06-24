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

export function anthropicProviderRequest(request) {
  return {
    ...request,
    messages: anthropicMessages(request),
    tools: normalizeAnthropicTools(request.tools || []),
    tool_choice: anthropicToolChoice(request.tool_choice)
  };
}

export function anthropicMessageResponse(request, modelResult) {
  const normalized = normalizeModelResult(modelResult);
  const response = {
    id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: request.model,
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0
    }
  };

  if (normalized.type === "final") {
    response.content.push({ type: "text", text: normalized.content || "" });
    return response;
  }

  response.stop_reason = "tool_use";
  response.content.push(...validateToolCalls({
    ...request,
    tools: normalizeAnthropicTools(request.tools || []),
    tool_choice: anthropicToolChoice(request.tool_choice)
  }, normalized.tool_calls || []).map((call) => ({
    type: "tool_use",
    id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
    name: call.name,
    input: call.arguments
  })));
  return response;
}

export function responseProviderRequest(request, previousRecords = []) {
  return {
    ...request,
    messages: [
      ...previousRecords.flatMap(responseRecordMessages),
      ...responseInputMessages(request)
    ],
    tools: normalizeResponseTools(request.tools || []),
    tool_choice: request.tool_choice || "auto"
  };
}

export function responseObject(request, modelResult) {
  const normalized = normalizeModelResult(modelResult);
  const createdAt = Math.floor(Date.now() / 1000);
  const response = {
    id: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: createdAt,
    status: "completed",
    completed_at: createdAt,
    error: null,
    incomplete_details: null,
    instructions: request.instructions || null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: request.model,
    output: [],
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: request.previous_response_id ?? null,
    reasoning: request.reasoning || { effort: null, summary: null },
    store: request.store ?? true,
    temperature: request.temperature ?? 1,
    text: request.text || { format: { type: "text" } },
    tool_choice: request.tool_choice || "auto",
    tools: request.tools || [],
    top_p: request.top_p ?? 1,
    truncation: request.truncation || "disabled",
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0
    },
    user: request.user ?? null,
    metadata: request.metadata || {}
  };

  if (normalized.type === "final") {
    response.output.push({
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: normalized.content || "",
        annotations: []
      }]
    });
    return response;
  }

  response.output.push(...validateToolCalls({
    ...request,
    tools: normalizeResponseTools(request.tools || [])
  }, normalized.tool_calls || []).map((call) => ({
    id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "function_call",
    status: "completed",
    call_id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
    name: call.name,
    arguments: JSON.stringify(call.arguments)
  })));
  return response;
}

export function responseInputItems(input) {
  if (typeof input === "string") {
    return [messageInputItem("user", input)];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input.map((item) => {
    if (item?.type === "function_call" || item?.type === "function_call_output") {
      return { ...item };
    }
    if (item?.role) {
      return messageInputItem(item.role, item.content, item.id);
    }
    return { ...item };
  });
}

export function responseInputItemList(items) {
  return {
    object: "list",
    data: items,
    first_id: items[0]?.id || null,
    last_id: items[items.length - 1]?.id || null,
    has_more: false
  };
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

export function streamResponseObject(response) {
  const events = [
    sseEvent("response.created", {
      ...response,
      status: "in_progress",
      completed_at: null,
      output: []
    })
  ];

  for (const item of response.output) {
    events.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      item
    }));

    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type !== "output_text") continue;
      events.push(sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: content.text || ""
      }));
      events.push(sseEvent("response.output_text.done", {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: content.text || ""
      }));
    }
  }

  events.push(sseEvent("response.completed", response));
  events.push("data: [DONE]\n\n");
  return events.join("");
}

export function streamAnthropicMessage(message) {
  const startMessage = {
    ...message,
    content: [],
    stop_reason: null
  };
  const events = [
    sseEvent("message_start", {
      type: "message_start",
      message: startMessage
    })
  ];

  for (const [index, block] of message.content.entries()) {
    if (block.type === "text") {
      events.push(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" }
      }));
      events.push(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text || "" }
      }));
      events.push(sseEvent("content_block_stop", {
        type: "content_block_stop",
        index
      }));
      continue;
    }

    if (block.type === "tool_use") {
      events.push(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {}
        }
      }));
      events.push(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input || {})
        }
      }));
      events.push(sseEvent("content_block_stop", {
        type: "content_block_stop",
        index
      }));
    }
  }

  events.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence
    },
    usage: {
      output_tokens: 0
    }
  }));
  events.push(sseEvent("message_stop", { type: "message_stop" }));
  return events.join("");
}

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function sseEvent(event, value) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
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
  if (isToolChoiceNone(request.tool_choice)) {
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

function responseInputMessages(request) {
  const messages = [];
  if (request.instructions) {
    messages.push({ role: "system", content: contentText(request.instructions) });
  }
  messages.push(...responseInputItemMessages(responseInputItems(request.input)));
  return messages;
}

function responseRecordMessages(record) {
  return [
    ...responseInputItemMessages(record.inputItems || []),
    ...responseOutputMessages(record.response?.output || [])
  ];
}

function responseInputItemMessages(items) {
  const messages = [];
  for (const item of items || []) {
    if (item?.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: contentText(item.output)
      });
      continue;
    }

    if (item?.type === "function_call") {
      messages.push({
        role: "assistant",
        content: JSON.stringify({
          type: item.type,
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments
        })
      });
      continue;
    }

    if (item?.role) {
      messages.push({
        role: item.role,
        content: contentText(item.content)
      });
    }
  }

  return messages;
}

function responseOutputMessages(output) {
  const messages = [];
  for (const item of output || []) {
    if (item?.type === "message") {
      messages.push({
        role: item.role || "assistant",
        content: contentText(item.content)
      });
      continue;
    }

    if (item?.type === "function_call") {
      messages.push({
        role: "assistant",
        content: JSON.stringify({
          type: item.type,
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments
        })
      });
    }
  }
  return messages;
}

function anthropicMessages(request) {
  const messages = [];
  if (request.system) {
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

function normalizeAnthropicTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || {}
    }
  }));
}

function anthropicToolChoice(toolChoice) {
  if (toolChoice?.type === "none") return "none";
  return "auto";
}

function isToolChoiceNone(toolChoice) {
  return toolChoice === "none" || toolChoice?.type === "none";
}

function messageInputItem(role, content, id = `msg_${crypto.randomUUID().replaceAll("-", "")}`) {
  return {
    id,
    type: "message",
    role,
    content: inputContent(content)
  };
}

function inputContent(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return { type: "input_text", text: part };
      if (part?.type) return part;
      return { type: "input_text", text: contentText(part) };
    });
  }
  return [{ type: "input_text", text: contentText(content) }];
}

function normalizeResponseTools(tools) {
  return tools.map((tool) => {
    if (tool?.type !== "function") return tool;
    if (tool.function?.name) return tool;
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || {},
        strict: tool.strict
      }
    };
  });
}

function contentText(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(contentBlockText).filter(Boolean).join("\n");
  }
  return JSON.stringify(content);
}

function contentBlockText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (part.type === "tool_use") {
    return JSON.stringify({
      type: part.type,
      id: part.id,
      name: part.name,
      input: part.input
    });
  }
  if (part.type === "tool_result") {
    return JSON.stringify({
      type: part.type,
      tool_use_id: part.tool_use_id,
      content: contentText(part.content),
      is_error: part.is_error || false
    });
  }
  if (part.type === "image" || part.type === "document") {
    return JSON.stringify(part);
  }
  return JSON.stringify(part);
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
