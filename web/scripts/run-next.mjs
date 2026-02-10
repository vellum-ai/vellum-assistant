#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

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

function commandExists(command) {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return false;
  }

  const directories = pathValue.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const lowerCommand = command.toLowerCase();

  for (const directory of directories) {
    for (const extension of extensions) {
      const normalizedExtension = extension.toLowerCase();
      const candidate =
        process.platform === "win32" &&
        normalizedExtension &&
        !lowerCommand.endsWith(normalizedExtension)
          ? `${command}${extension}`
          : command;

      if (existsSync(join(directory, candidate))) {
        return true;
      }
    }
  }

  return false;
}

if (commandExists("bunx")) {
  const bunRun = run("bunx", ["--bun", "next", nextCommand, ...args]);

  if (!bunRun.error) {
    process.exit(bunRun.status ?? 0);
  }

  if (bunRun.error.code !== "ENOENT") {
    console.error(`[run-next] Failed to launch bunx: ${bunRun.error.message}`);
    process.exit(1);
  }
}

const nextRun = run("next", [nextCommand, ...args]);

if (nextRun.error) {
  console.error(`[run-next] Failed to launch next: ${nextRun.error.message}`);
  process.exit(1);
}

process.exit(nextRun.status ?? 0);
