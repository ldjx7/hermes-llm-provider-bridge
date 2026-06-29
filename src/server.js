import http from "node:http";

import { startLocalAnthropicProxy } from "./anthropic-proxy.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config-store.js";

export async function startServer(configPath) {
  const config = await loadConfig(configPath);
  const localProxy = await startLocalAnthropicProxy(config);
  const app = createApp({ config });
  const host = process.env.BRIDGE_HOST || config.server?.host || "127.0.0.1";
  const port = Number(process.env.BRIDGE_PORT || config.server?.port || 18777);

  const server = http.createServer((req, res) => {
    app.nodeHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error) => {
    localProxy?.close();
    throw error;
  });
  if (localProxy) {
    server.on("close", () => localProxy.close());
  }
  console.log(`Hermes provider bridge listening on http://${host}:${port}/v1`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = getFlag("--config") || process.env.BRIDGE_CONFIG || "bridge.config.json";
  startServer(configPath).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

function getFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}
