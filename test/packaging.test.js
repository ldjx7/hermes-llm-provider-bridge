import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Docker image bootstraps bridge config when it is not mounted", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const entrypoint = await readFile("docker-entrypoint.sh", "utf8");
  const exampleConfig = JSON.parse(await readFile("bridge.config.example.json", "utf8"));

  assert.match(dockerfile, /COPY docker-entrypoint\.sh/);
  assert.match(dockerfile, /ENTRYPOINT \["\.\/docker-entrypoint\.sh"\]/);
  assert.match(entrypoint, /bridge\.config\.example\.json/);
  assert.match(entrypoint, /cp "\/app\/bridge\.config\.example\.json" "\$BRIDGE_CONFIG"/);
  assert.equal(exampleConfig.claude.stdin, "{{prompt}}");
  assert.ok(!exampleConfig.claude.args.includes("{{prompt}}"));
});

test("Compose default deployment only requires Claude config mount", async () => {
  const compose = await readFile("compose.yml", "utf8");

  assert.match(compose, /\/profiles\/claude-max/);
  assert.doesNotMatch(compose, /\.\/config:\/config/);
});
