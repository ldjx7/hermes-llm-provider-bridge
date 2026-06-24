import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";

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

  throw new HttpError(400, `Unsupported profile provider "${profile.provider}"`, "bad_config");
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
