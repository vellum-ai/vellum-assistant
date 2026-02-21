#!/usr/bin/env bun

import { hatch } from "./commands/hatch";
import { ps } from "./commands/ps";
import { retire } from "./commands/retire";
import { sleep } from "./commands/sleep";
import { wake } from "./commands/wake";

const commands = {
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
    console.log("Usage: vellum-cli <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  hatch    Create a new assistant instance");
    console.log("  ps       List assistants (or processes for a specific assistant)");
    console.log("  retire   Delete an assistant instance");
    console.log("  sleep    Stop the daemon process");
    console.log("  wake     Start the daemon and gateway");
    process.exit(0);
  }

  const command = commands[commandName as CommandName];

  if (!command) {
    console.error(`Error: Unknown command '${commandName}'`);
    console.error("Run 'vellum-cli --help' for usage information.");
    process.exit(1);
  }

  try {
    await command();
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
