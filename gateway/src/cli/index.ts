#!/usr/bin/env bun

/**
 * Operator CLI for gateway-owned state. Invoked as `gateway <command>`.
 *
 * This entry starts the CLI, not the gateway HTTP server. The server
 * remains `bun run src/index.ts`.
 */

import { runContactsCommand } from "./contacts.js";

function printUsage(): void {
  console.log("Usage: gateway <command>");
  console.log("");
  console.log("Operator commands for gateway-owned state.");
  console.log("");
  console.log("Commands:");
  console.log("  contacts    Manage contact ACL (list, get, set-risk-threshold)");
}

const args = process.argv.slice(2);
const command = args[0];

if (command === "--help" || command === "-h" || !command) {
  printUsage();
  process.exit(0);
}

if (command === "contacts") {
  const code = await runContactsCommand(args.slice(1));
  process.exit(code);
}

console.error(`Unknown command: ${command}`);
printUsage();
process.exit(1);
