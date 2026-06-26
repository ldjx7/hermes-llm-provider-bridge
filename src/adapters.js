import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { HttpError } from "./errors.js";
import { normalizeCliResult, validateProviderResult } from "./openai.js";
import { buildRepairPrompt, buildStructuredPrompt } from "./prompt.js";

const DEFAULT_MAX_STDIN_BYTES = 10 * 1024 * 1024;

export async function runProvider({ config, profileName, profile, model, request }) {
  if (profile.provider === "mock") {
    await recordTestCall(config, {
      profile: profileName,
      model: request.model,
      backendModel: model?.backendModel,
      messages: request.messages || []
    });
    if (profile.mockDelayMs) {
      await delay(profile.mockDelayMs);
    }
    return profile.mockResponse || { type: "final", content: "" };
  }

  if (profile.provider === "cli-json") {
    const prompt = buildStructuredPrompt(request, { profileName, profile, model });
    return await runCliJsonWithRepair(profile, model, prompt, request);
  }

  if (profile.provider === "openai-chat") {
    return await runOpenAIChatProvider(profile, model, request);
  }

  throw new HttpError(400, `Unsupported profile provider "${profile.provider}"`, "bad_config");
}

async function runOpenAIChatProvider(profile, model, request) {
  const settings = await readSettings(profile);
  const baseUrl = profile.baseUrl || settings.env?.OPENAI_BASE_URL || settings.env?.ANTHROPIC_BASE_URL;
  const apiKey = profile.apiKey
    || (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined)
    || settings.env?.OPENAI_API_KEY
    || settings.env?.ANTHROPIC_AUTH_TOKEN;

  if (!baseUrl) {
    throw new HttpError(400, "openai-chat profile is missing baseUrl", "bad_config");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.timeoutMs || 120000);
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(profile.headers || {})
      },
      body: JSON.stringify(openAIChatRequest(profile, model, request)),
      signal: controller.signal
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new HttpError(response.status, openAIErrorMessage(response.status, payload), "provider_failed");
    }
    const result = openAIChatResult(payload);
    validateProviderResult(request, result);
    return result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new HttpError(504, `OpenAI upstream timed out after ${profile.timeoutMs || 120000}ms`, "provider_timeout");
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, `OpenAI upstream failed: ${error.message}`, "provider_failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function readSettings(profile) {
  const settingsPath = profile.settingsFile || (profile.configDir ? path.join(profile.configDir, "settings.json") : undefined);
  if (!settingsPath) return {};
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function openAIChatRequest(profile, model, request) {
  const body = {
    model: model?.backendModel || model?.id || request.model,
    messages: request.messages || []
  };

  copyOptional(body, request, [
    "frequency_penalty",
    "logit_bias",
    "logprobs",
    "metadata",
    "modalities",
    "n",
    "parallel_tool_calls",
    "prediction",
    "presence_penalty",
    "reasoning_effort",
    "response_format",
    "seed",
    "service_tier",
    "stop",
    "store",
    "stream_options",
    "temperature",
    "top_logprobs",
    "top_p",
    "user"
  ]);

  const maxTokens = request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (Array.isArray(request.tools) && request.tools.length > 0) body.tools = request.tools;
  if (request.tool_choice !== undefined) body.tool_choice = normalizeOpenAIToolChoice(request.tool_choice);

  return {
    ...body,
    ...(profile.requestDefaults || {})
  };
}

function openAIChatResult(payload) {
  const message = payload.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new HttpError(502, "OpenAI upstream returned no assistant message", "bad_provider_result");
  }

  const toolCalls = normalizeOpenAIToolCalls(message.tool_calls);
  if (toolCalls.length > 0) {
    return { type: "tool_calls", tool_calls: toolCalls };
  }
  if (message.function_call?.name) {
    return {
      type: "tool_calls",
      tool_calls: [{
        name: message.function_call.name,
        arguments: message.function_call.arguments || {}
      }]
    };
  }
  return { type: "final", content: openAIContentText(message.content) };
}

function normalizeOpenAIToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call) => call?.type === "function" && call.function?.name)
    .map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments || {}
    }));
}

function openAIContentText(content) {
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

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function normalizeOpenAIToolChoice(toolChoice) {
  if (toolChoice?.type === "none") return "none";
  if (toolChoice?.type === "auto") return "auto";
  return toolChoice;
}

function openAIErrorMessage(status, payload) {
  const message = payload?.error?.message || payload?.message || JSON.stringify(payload);
  return `OpenAI upstream returned HTTP ${status}: ${message}`;
}

function copyOptional(target, source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

async function runCliJsonWithRepair(profile, model, prompt, request) {
  const maxAttempts = 1 + Math.max(0, Number(profile.repairRetries ?? 1) || 0);
  let currentPrompt = prompt;
  let lastStdout = "";
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastStdout = await runCli(profile, model, currentPrompt);
    let result;
    try {
      result = normalizeCliResult(lastStdout);
      return validateProviderResult(request, result);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      currentPrompt = buildRepairPrompt({
        originalPrompt: prompt,
        badOutput: result ? JSON.stringify(result) : lastStdout,
        errorMessage: error.message,
        availableTools: toolNames(request)
      });
    }
  }

  throw lastError || new HttpError(502, "Provider returned invalid JSON", "bad_provider_result");
}

function toolNames(request) {
  return (request.tools || [])
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => tool.function.name);
}

async function recordTestCall(config, call) {
  if (!config.test?.callsFile) return;
  await appendFile(config.test.callsFile, `${JSON.stringify(call)}\n`);
}

async function runCli(profile, model, prompt) {
  const command = profile.command;
  if (!command) {
    throw new HttpError(400, "cli-json profile is missing command", "bad_config");
  }

  const vars = {
    prompt,
    model: model?.id || "",
    backendModel: model?.backendModel || model?.id || ""
  };
  const args = (profile.args || []).map((arg) => interpolate(arg, vars));
  const stdinInput = profile.stdin === undefined ? undefined : interpolate(profile.stdin, vars);
  if (stdinInput !== undefined) {
    assertStdinSize(profile, stdinInput);
  }

  const env = {
    ...process.env,
    ...(profile.env || {})
  };
  if (profile.configDir) {
    env.CLAUDE_CONFIG_DIR = profile.configDir;
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const child = spawn(command, args, {
      cwd: profile.cwd || process.cwd(),
      env,
      stdio: [stdinInput === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new HttpError(504, `Provider command timed out after ${profile.timeoutMs || 120000}ms`, "provider_timeout"));
    }, profile.timeoutMs || 120000);

    if (stdinInput !== undefined) {
      child.stdin.on("error", (error) => {
        if (error.code === "EPIPE") return;
        fail(new HttpError(502, `Provider command stdin failed: ${error.message}`, "provider_stdin_failed"));
      });
      child.stdin.end(stdinInput);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (error.code === "E2BIG") {
        fail(new HttpError(413, "Provider command arguments are too large; pass the prompt through profile.stdin instead of argv", "provider_input_too_large"));
        return;
      }
      fail(new HttpError(502, `Provider command failed to start: ${error.message}`, "provider_spawn_failed"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new HttpError(502, `Provider command exited with code ${code}: ${stderr.trim()}`, "provider_failed"));
        return;
      }
      resolve(stdout);
    });
  });
}

function assertStdinSize(profile, input) {
  const actual = Buffer.byteLength(input, "utf8");
  const limit = maxStdinBytes(profile);
  if (actual <= limit) return;

  throw new HttpError(
    413,
    `Provider stdin input exceeds ${limit} bytes (${actual} bytes)`,
    "provider_input_too_large"
  );
}

function maxStdinBytes(profile) {
  const configured = Number(profile.maxStdinBytes);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_MAX_STDIN_BYTES;
}

function interpolate(value, vars) {
  return String(value)
    .replaceAll("{{prompt}}", vars.prompt)
    .replaceAll("{{model}}", vars.model)
    .replaceAll("{{backendModel}}", vars.backendModel);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms)));
}
