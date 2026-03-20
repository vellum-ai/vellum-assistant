#!/usr/bin/env bun

import cliPkg from "../package.json";
import { backup } from "./commands/backup";
import { clean } from "./commands/clean";
import { client } from "./commands/client";
import { hatch } from "./commands/hatch";
import { login, logout, whoami } from "./commands/login";
import { pair } from "./commands/pair";
import { ps } from "./commands/ps";
import { recover } from "./commands/recover";
import { restore } from "./commands/restore";
import { retire } from "./commands/retire";
import { rollback } from "./commands/rollback";
import { setup } from "./commands/setup";
import { sleep } from "./commands/sleep";
import { ssh } from "./commands/ssh";
import { tunnel } from "./commands/tunnel";
import { upgrade } from "./commands/upgrade";
import { use } from "./commands/use";
import { wake } from "./commands/wake";
import {
  getActiveAssistant,
  findAssistantByName,
  loadLatestAssistant,
  setActiveAssistant,
} from "./lib/assistant-config";
import { loadGuardianToken } from "./lib/guardian-token";
import { checkHealth } from "./lib/health-check";

const commands = {
  backup,
  clean,
  client,
  hatch,
  login,
  logout,
  pair,
  ps,
  recover,
  restore,
  retire,
  rollback,
  setup,
  sleep,
  ssh,
  tunnel,
  upgrade,
  use,
  wake,
  whoami,
} as const;

type CommandName = keyof typeof commands;

function printHelp(): void {
  console.log("Usage: vellum <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  backup   Export a backup of a running assistant");
  console.log("  clean    Kill orphaned vellum processes");
  console.log("  client   Connect to a hatched assistant");
  console.log("  hatch    Create a new assistant instance");
  console.log("  login    Log in to the Vellum platform");
  console.log("  logout   Log out of the Vellum platform");
  console.log("  pair     Pair with a remote assistant via QR code");
  console.log(
    "  ps       List assistants (or processes for a specific assistant)",
  );
  console.log("  recover  Restore a previously retired local assistant");
  console.log("  restore  Restore a .vbundle backup into a running assistant");
  console.log("  retire   Delete an assistant instance");
  console.log(
    "  rollback  Roll back a Docker assistant to the previous version",
  );
  console.log("  setup    Configure API keys interactively");
  console.log("  sleep    Stop the assistant process");
  console.log("  ssh      SSH into a remote assistant instance");
  console.log("  tunnel   Create a tunnel for a locally hosted assistant");
  console.log("  upgrade  Upgrade an assistant to the latest version");
  console.log("  use      Set the active assistant for commands");
  console.log("  wake     Start the assistant and gateway");
  console.log("  whoami   Show current logged-in user");
  console.log("");
  console.log("Options:");
  console.log(
    "  --no-color, --plain   Disable colored output (honors NO_COLOR env)",
  );
  console.log("  --version, -v         Show version");
  console.log("  --help, -h            Show this help");
}

/**
 * Check for --no-color / --plain flags and set NO_COLOR env var
 * before any terminal capability detection runs.
 *
 * Per https://no-color.org/, setting NO_COLOR to any non-empty value
 * signals that color output should be suppressed.
 */
function applyNoColorFlags(argv: string[]): void {
  if (argv.includes("--no-color") || argv.includes("--plain")) {
    process.env.NO_COLOR = "1";
  }
}

/**
 * If a running assistant is detected, launch the TUI client and return true.
 * Otherwise return false so the caller can fall back to help text.
 */
async function tryLaunchClient(): Promise<boolean> {
  const activeName = getActiveAssistant();
  const entry = activeName
    ? findAssistantByName(activeName)
    : loadLatestAssistant();

  if (!entry) return false;

  const url = entry.localUrl || entry.runtimeUrl;
  if (!url) return false;

  const token = loadGuardianToken(entry.assistantId)?.accessToken;
  const result = await checkHealth(url, token);
  if (result.status !== "healthy") return false;

  // Ensure the resolved assistant is active so client() can find it
  // (client() independently reads the active assistant from config).
  setActiveAssistant(String(entry.assistantId));

  await client();
  return true;
}

async function main() {
  const args = process.argv.slice(2);

  // Must run before any command or terminal-capabilities usage
  applyNoColorFlags(args);

  // Global flags that are not command names
  const GLOBAL_FLAGS = new Set(["--no-color", "--plain"]);
  const commandName = args.find((a) => !GLOBAL_FLAGS.has(a));

  // Strip global flags from process.argv so subcommands that parse
  // process.argv.slice(3) don't see them as positional arguments.
  const filteredArgs = args.filter((a) => !GLOBAL_FLAGS.has(a));
  process.argv = [...process.argv.slice(0, 2), ...filteredArgs];

  if (commandName === "--version" || commandName === "-v") {
    console.log(`@vellumai/cli v${cliPkg.version}`);
    process.exit(0);
  }

  if (commandName === "--help" || commandName === "-h") {
    printHelp();
    process.exit(0);
  }

  if (!commandName) {
    const launched = await tryLaunchClient();
    if (!launched) {
      printHelp();
    }
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
