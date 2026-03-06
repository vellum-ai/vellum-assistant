#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import cliPkg from "../package.json";
import { client } from "./commands/client";
import { hatch } from "./commands/hatch";
import { login, logout, whoami } from "./commands/login";
import { pair } from "./commands/pair";
import { ps } from "./commands/ps";
import { recover } from "./commands/recover";
import { retire } from "./commands/retire";
import { skills } from "./commands/skills";
import { sleep } from "./commands/sleep";
import { ssh } from "./commands/ssh";
import { tunnel } from "./commands/tunnel";
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
  skills,
  sleep,
  ssh,
  tunnel,
  wake,
  whoami,
} as const;

type CommandName = keyof typeof commands;

function resolveAssistantEntry(): string | undefined {
  // When installed globally, resolve from node_modules
  try {
    const require = createRequire(import.meta.url);
    const assistantPkgPath =
      require.resolve("@vellumai/assistant/package.json");
    return join(dirname(assistantPkgPath), "src", "index.ts");
  } catch {
    // For local development, resolve from sibling directory
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const localPath = join(
      __dirname,
      "..",
      "..",
      "assistant",
      "src",
      "index.ts",
    );
    if (existsSync(localPath)) {
      return localPath;
    }
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const commandName = args[0];

  if (commandName === "--version" || commandName === "-v") {
    console.log(`@vellumai/cli v${cliPkg.version}`);
    process.exit(0);
  }

  if (!commandName || commandName === "--help" || commandName === "-h") {
    console.log("Usage: assistant <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  autonomy View and configure autonomy tiers");
    console.log("  client   Connect to a hatched assistant");
    console.log("  config   Manage configuration");
    console.log("  contacts Manage assistant contacts");
    console.log("  email    Email operations (provider-agnostic)");
    console.log("  hatch    Create a new assistant instance");
    console.log("  login    Log in to the Vellum platform");
    console.log("  logout   Log out of the Vellum platform");
    console.log("  pair     Pair with a remote assistant via QR code");
    console.log(
      "  ps       List assistants (or processes for a specific assistant)",
    );
    console.log("  recover  Restore a previously retired local assistant");
    console.log("  retire   Delete an assistant instance");
    console.log("  skills   Browse and install skills from the Vellum catalog");
    console.log("  sleep    Stop the assistant process");
    console.log("  ssh      SSH into a remote assistant instance");
    console.log("  tunnel   Create a tunnel for a locally hosted assistant");
    console.log("  wake     Start the assistant and gateway");
    console.log("  whoami   Show current logged-in user");
    process.exit(0);
  }

  const command = commands[commandName as CommandName];

  if (!command) {
    const assistantEntry = resolveAssistantEntry();
    if (assistantEntry) {
      const child = spawn("bun", ["run", assistantEntry, ...args], {
        stdio: "inherit",
      });
      child.on("exit", (code) => {
        process.exit(code ?? 1);
      });
    } else {
      console.error(`Unknown command: ${commandName}`);
      console.error("Install the full stack with: bun install -g vellum");
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
