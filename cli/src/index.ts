#!/usr/bin/env bun

import cliPkg from "../package.json";
import { client } from "./commands/client";
import { hatch } from "./commands/hatch";
import { login, logout, whoami } from "./commands/login";
import { pair } from "./commands/pair";
import { ps } from "./commands/ps";
import { recover } from "./commands/recover";
import { retire } from "./commands/retire";
import { sleep } from "./commands/sleep";
import { ssh } from "./commands/ssh";
import { tunnel } from "./commands/tunnel";
import { use } from "./commands/use";
import { wake } from "./commands/wake";

const commands = {
  client,
  hatch,
  login,
  logout,
  pair,
  ps,
  recover,
  retire,
  sleep,
  ssh,
  tunnel,
  use,
  wake,
  whoami,
} as const;

type CommandName = keyof typeof commands;

async function main() {
  const args = process.argv.slice(2);
  const commandName = args[0];

  if (commandName === "--version" || commandName === "-v") {
    console.log(`@vellumai/cli v${cliPkg.version}`);
    process.exit(0);
  }

  if (!commandName || commandName === "--help" || commandName === "-h") {
    console.log("Usage: vellum <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  client   Connect to a hatched assistant");
    console.log("  hatch    Create a new assistant instance");
    console.log("  login    Log in to the Vellum platform");
    console.log("  logout   Log out of the Vellum platform");
    console.log("  pair     Pair with a remote assistant via QR code");
    console.log(
      "  ps       List assistants (or processes for a specific assistant)",
    );
    console.log("  recover  Restore a previously retired local assistant");
    console.log("  retire   Delete an assistant instance");
    console.log("  sleep    Stop the assistant process");
    console.log("  ssh      SSH into a remote assistant instance");
    console.log("  tunnel   Create a tunnel for a locally hosted assistant");
    console.log("  use      Set the active assistant for commands");
    console.log("  wake     Start the assistant and gateway");
    console.log("  whoami   Show current logged-in user");
    process.exit(0);
  }

  const command = commands[commandName as CommandName];

  if (!command) {
    console.error(`Unknown command: ${commandName}`);
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
