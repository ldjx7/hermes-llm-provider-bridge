#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const attemptsFile = process.env.FAKE_CLI_ATTEMPTS_FILE;
const current = attemptsFile ? readAttempt(attemptsFile) : 0;
const next = current + 1;
if (attemptsFile) writeFileSync(attemptsFile, String(next));

if (next === 1) {
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
