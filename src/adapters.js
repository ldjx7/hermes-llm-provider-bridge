import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import { HttpError } from "./errors.js";
import { normalizeCliResult } from "./openai.js";
import { buildRepairPrompt, buildStructuredPrompt } from "./prompt.js";

export async function runProvider({ config, profileName, profile, model, request }) {
  if (profile.provider === "mock") {
    await recordTestCall(config, { profile: profileName, model: request.model, messages: request.messages || [] });
    if (profile.mockDelayMs) {
      await delay(profile.mockDelayMs);
    }
    return profile.mockResponse || { type: "final", content: "" };
  }

  if (profile.provider === "cli-json") {
    const prompt = buildStructuredPrompt(request, { profileName, profile, model });
    return await runCliJsonWithRepair(profile, model, prompt);
  }

  throw new HttpError(400, `Unsupported profile provider "${profile.provider}"`, "bad_config");
}

async function runCliJsonWithRepair(profile, model, prompt) {
  const maxAttempts = 1 + Math.max(0, Number(profile.repairRetries ?? 1) || 0);
  let currentPrompt = prompt;
  let lastStdout = "";
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastStdout = await runCli(profile, model, currentPrompt);
    try {
      return normalizeCliResult(lastStdout);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      currentPrompt = buildRepairPrompt({
        originalPrompt: prompt,
        badOutput: lastStdout,
        errorMessage: error.message
      });
    }
  }

  throw lastError || new HttpError(502, "Provider returned invalid JSON", "bad_provider_result");
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

  const args = (profile.args || []).map((arg) => interpolate(arg, {
    prompt,
    model: model?.id || "",
    backendModel: model?.backendModel || model?.id || ""
  }));

  const env = {
    ...process.env,
    ...(profile.env || {})
  };
  if (profile.configDir) {
    env.CLAUDE_CONFIG_DIR = profile.configDir;
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: profile.cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new HttpError(504, `Provider command timed out after ${profile.timeoutMs || 120000}ms`, "provider_timeout"));
    }, profile.timeoutMs || 120000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new HttpError(502, `Provider command failed to start: ${error.message}`, "provider_spawn_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new HttpError(502, `Provider command exited with code ${code}: ${stderr.trim()}`, "provider_failed"));
        return;
      }
      resolve(stdout);
    });
  });
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
