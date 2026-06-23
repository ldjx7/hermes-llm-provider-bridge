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
  const settings = await readClaudeSettings(config);
  const models = configuredModels(settings);
  const provider = claudeProviderConfig(config);
  const requested = requestedModel || "hermes-bridge";
  const backendModel = requested === "hermes-bridge"
    ? defaultModel(settings, models)
    : requested;

  if (!backendModel) {
    throw new HttpError(400, "No Claude models are configured in settings.json", "bad_config");
  }

  if (models.length > 0 && !models.some((model) => model.id === backendModel) && !provider.allowUnlistedModels) {
    throw new HttpError(400, `Model "${backendModel}" is not configured in Claude settings`, "bad_request");
  }

  return {
    profileName: "claude",
    profile: provider,
    model: {
      id: requested,
      backendModel
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
      "{{prompt}}",
      "--output-format",
      "json",
      "--no-session-persistence"
    ],
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

function defaultModel(settings, models) {
  const requestedDefault = typeof settings.model === "string" ? settings.model : "";
  const env = settings.env || {};
  const family = requestedDefault.toUpperCase();

  return env[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`]
    || env[`ANTHROPIC_DEFAULT_${family}_MODEL`]
    || models.find((model) => model.id === requestedDefault)?.id
    || requestedDefault
    || models[0]?.id;
}
