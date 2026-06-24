import { readFile } from "node:fs/promises";
import path from "node:path";

import { HttpError } from "./errors.js";

export function usesClaudeSettings(config) {
  return config.modelSource === "claude-settings" || Boolean(config.claude);
}

export async function listClaudeSettingsModels(config) {
  const settings = await readClaudeSettings(config);
  return configuredModels(settings).map((model) => ({
    id: model.id,
    ownedBy: claudeProviderConfig(config).ownedBy || "claude-code"
  }));
}

export async function resolveClaudeSettingsRoute(config, requestedModel) {
  if (!requestedModel || typeof requestedModel !== "string") {
    throw new HttpError(400, "Request body must include model", "bad_request");
  }

  const settings = await readClaudeSettings(config);
  const models = configuredModels(settings);
  const provider = claudeProviderConfig(config);

  if (models.length === 0) {
    throw new HttpError(400, "No Claude models are configured in settings.json", "bad_config");
  }

  if (!models.some((model) => model.id === requestedModel)) {
    throw new HttpError(400, `Model "${requestedModel}" is not available`, "bad_request");
  }

  return {
    profileName: "claude",
    profile: provider,
    model: {
      id: requestedModel,
      backendModel: requestedModel
    }
  };
}

export function claudeProviderConfig(config) {
  return {
    provider: "cli-json",
    ownedBy: "claude-code",
    configDir: "/profiles/claude-max",
    timeoutMs: 180000,
    repairRetries: 1,
    command: "claude",
    args: [
      "--model",
      "{{backendModel}}",
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence"
    ],
    stdin: "{{prompt}}",
    ...(config.claude || {})
  };
}

async function readClaudeSettings(config) {
  const provider = claudeProviderConfig(config);
  const settingsPath = path.join(provider.configDir, "settings.json");
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function configuredModels(settings) {
  const env = settings.env || {};
  const byFamily = new Map();

  for (const [key, value] of Object.entries(env)) {
    if (!value || typeof value !== "string") continue;

    let match = key.match(/^ANTHROPIC_DEFAULT_(.+)_MODEL_NAME$/);
    if (match) {
      byFamily.set(match[1], { id: value });
      continue;
    }

    match = key.match(/^ANTHROPIC_DEFAULT_(.+)_MODEL$/);
    if (match && !byFamily.has(match[1])) {
      byFamily.set(match[1], { id: value });
    }
  }

  return [...new Map([...byFamily.values()].map((model) => [model.id, model])).values()];
}
