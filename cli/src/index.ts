#!/usr/bin/env bun

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { client } from "./commands/client";
import { hatch } from "./commands/hatch";
import { ps } from "./commands/ps";
import { retire } from "./commands/retire";
import { sleep } from "./commands/sleep";
import { wake } from "./commands/wake";

const commands = {
  client,
  hatch,
  ps,
  retire,
  sleep,
  wake,
} as const;

type CommandName = keyof typeof commands;

async function main() {
  const args = process.argv.slice(2);
  const commandName = args[0];

  if (!commandName || commandName === "--help" || commandName === "-h") {
    console.log("Usage: vellum <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  client   Connect to a hatched assistant");
    console.log("  hatch    Create a new assistant instance");
    console.log("  ps       List assistants (or processes for a specific assistant)");
    console.log("  retire   Delete an assistant instance");
    console.log("  sleep    Stop the daemon process");
    console.log("  wake     Start the daemon and gateway");
    process.exit(0);
  }

  const command = commands[commandName as CommandName];

  if (!command) {
    try {
      const require = createRequire(import.meta.url);
      const assistantPkgPath = require.resolve(
        "@vellumai/assistant/package.json"
      );
      const assistantEntry = join(
        dirname(assistantPkgPath),
        "src",
        "index.ts"
      );
      const child = spawn("bun", ["run", assistantEntry, ...args], {
        stdio: "inherit",
      });
      child.on("exit", (code) => {
        process.exit(code ?? 1);
      });
    } catch {
      console.error(`Unknown command: ${commandName}`);
      console.error(
        "Install the full stack with: bun install -g vellum"
      );
      process.exit(1);
    }
    return;
  }

  try {
    await command();
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
