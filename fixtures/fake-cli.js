#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const attemptsFile = process.env.FAKE_CLI_ATTEMPTS_FILE;
const mode = process.env.FAKE_CLI_MODE || "invalid-json";
const prompt = process.argv[2] || "";
const current = attemptsFile ? readAttempt(attemptsFile) : 0;
const next = current + 1;
if (attemptsFile) writeFileSync(attemptsFile, String(next));

if (mode === "stdin-echo") {
  const stdin = readFileSync(0, "utf8");
  const marker = process.env.FAKE_CLI_MARKER || "";
  process.stdout.write(JSON.stringify({
    type: "final",
    content: JSON.stringify({
      markerInStdin: stdin.includes(marker),
      markerInArgv: process.argv.slice(2).some((arg) => arg.includes(marker))
    })
  }));
} else if (mode === "invalid-tool") {
  if (next === 1) {
    process.stdout.write(JSON.stringify({
      type: "tool_calls",
      tool_calls: [
        { name: "web_search", arguments: { query: "cs2 major winner" } }
      ]
    }));
  } else if (prompt.includes("web_search") && prompt.includes("run_shell")) {
    process.stdout.write(JSON.stringify({ type: "final", content: "repaired tool intent" }));
  } else {
    process.stdout.write(JSON.stringify({ type: "final", content: "missing repair context" }));
  }
} else if (next === 1) {
  process.stdout.write("this is not json");
} else {
  process.stdout.write(JSON.stringify({
    type: "result",
    result: JSON.stringify({ type: "final", content: "repaired" })
  }));
}

function readAttempt(file) {
  try {
    return Number(readFileSync(file, "utf8") || "0");
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}
