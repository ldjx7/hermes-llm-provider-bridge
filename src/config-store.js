import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function loadConfig(configPath = process.env.BRIDGE_CONFIG || "bridge.config.json") {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const config = JSON.parse(raw);
  config.__configPath = absolutePath;
  config.__baseDir = path.dirname(absolutePath);
  if (config.stateFile && !path.isAbsolute(config.stateFile)) {
    config.stateFile = path.resolve(config.__baseDir, config.stateFile);
  }
  return config;
}

export async function getActiveProfileName(config) {
  const state = await readState(config.stateFile);
  const candidate = state?.activeProfile || config.defaultProfile || Object.keys(config.profiles || {})[0];
  if (!candidate || !config.profiles?.[candidate]) {
    throw new ConfigError(`Active profile "${candidate}" is not defined`);
  }
  return candidate;
}

export async function getActiveProfile(config) {
  const name = await getActiveProfileName(config);
  return { name, profile: config.profiles[name] };
}

export function listProfiles(config) {
  return Object.keys(config.profiles || {});
}

export async function listExposedModels(config) {
  const { name: activeProfileName, profile: activeProfile } = await getActiveProfile(config);
  const models = new Map();

  for (const model of activeProfile.models || []) {
    models.set(model.id, {
      id: model.id,
      ownedBy: model.ownedBy || activeProfile.ownedBy || activeProfile.provider || "bridge",
      profileName: activeProfileName
    });
  }

  for (const [profileName, profile] of Object.entries(config.profiles || {})) {
    models.set(profileName, {
      id: profileName,
      ownedBy: profile.ownedBy || profile.provider || "bridge",
      profileName
    });
  }

  return [...models.values()];
}

export async function resolveModelRoute(config, requestedModel) {
  if (requestedModel && config.profiles?.[requestedModel]) {
    const profile = config.profiles[requestedModel];
    const model = firstModelForProfile(requestedModel, profile);
    return {
      profileName: requestedModel,
      profile,
      model: { ...model, id: requestedModel }
    };
  }

  const { name, profile } = await getActiveProfile(config);
  const model = findModel(profile, requestedModel);
  return { profileName: name, profile, model };
}

export async function switchProfile(config, profileName) {
  if (!config.profiles?.[profileName]) {
    throw new ConfigError(`Profile "${profileName}" is not defined`);
  }
  if (!config.stateFile) {
    throw new ConfigError("Config is missing stateFile");
  }
  await mkdir(path.dirname(config.stateFile), { recursive: true });
  const state = {
    activeProfile: profileName,
    updatedAt: new Date().toISOString()
  };
  await writeFile(config.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function findModel(profile, requestedModel) {
  const models = profile.models || [];
  if (requestedModel) {
    const match = models.find((model) => model.id === requestedModel);
    if (match) return match;
  }
  return models[0];
}

function firstModelForProfile(profileName, profile) {
  const model = (profile.models || [])[0];
  if (model) return model;
  return { id: profileName, backendModel: profileName };
}

async function readState(stateFile) {
  if (!stateFile) return null;
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
    this.statusCode = 400;
  }
}
