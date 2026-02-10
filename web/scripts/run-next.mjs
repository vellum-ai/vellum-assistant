#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const [nextCommand, ...args] = process.argv.slice(2);

if (!nextCommand) {
  console.error("Usage: node scripts/run-next.mjs <dev|build|start> [...args]");
  process.exit(1);
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
}

const bunRun = run("bunx", ["--bun", "next", nextCommand, ...args]);

if (!bunRun.error) {
  process.exit(bunRun.status ?? 0);
}

if (bunRun.error.code !== "ENOENT") {
  console.error(`[run-next] Failed to launch bunx: ${bunRun.error.message}`);
  process.exit(1);
}

const nextRun = run("next", [nextCommand, ...args]);

if (nextRun.error) {
  console.error(`[run-next] Failed to launch next: ${nextRun.error.message}`);
  process.exit(1);
}

process.exit(nextRun.status ?? 0);
