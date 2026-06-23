#!/usr/bin/env node
import { startServer } from "./server.js";
import { getActiveProfileName, listProfiles, loadConfig, switchProfile } from "./config-store.js";
import { probeActiveProfile } from "./probe.js";

const args = process.argv.slice(2);
const command = args[0] || "help";
const configPath = flagValue("--config") || process.env.BRIDGE_CONFIG || "bridge.config.json";

try {
  if (command === "serve") {
    await startServer(configPath);
  } else if (command === "profiles" || command === "list") {
    const config = await loadConfig(configPath);
    const active = await getActiveProfileName(config);
    for (const profile of listProfiles(config)) {
      console.log(`${profile === active ? "*" : " "} ${profile}`);
    }
  } else if (command === "current") {
    const config = await loadConfig(configPath);
    console.log(await getActiveProfileName(config));
  } else if (command === "use") {
    const profile = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
    if (!profile) throw new Error("Usage: hermes-bridge use <profile> [--config bridge.config.json]");
    const config = await loadConfig(configPath);
    await switchProfile(config, profile);
    console.log(profile);
  } else if (command === "probe") {
    const config = await loadConfig(configPath);
    const prompt = args
      .filter((arg, index) => index > 0 && arg !== "--config" && args[index - 1] !== "--config")
      .join(" ") || "Reply with one short sentence.";
    const result = await probeActiveProfile(config, prompt);
    console.log(JSON.stringify(result, null, 2));
  } else {
    usage();
    process.exitCode = command === "help" ? 0 : 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function flagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function usage() {
  console.log(`Usage:
  hermes-bridge serve [--config bridge.config.json]
  hermes-bridge profiles [--config bridge.config.json]
  hermes-bridge current [--config bridge.config.json]
  hermes-bridge use <profile> [--config bridge.config.json]
  hermes-bridge probe [prompt] [--config bridge.config.json]`);
}
