#!/usr/bin/env bun
/**
 * CES CLI — lightweight credential CRUD for the CES container.
 *
 * Operates directly on the encrypted key store (`keys.enc` + `store.key`)
 * without requiring the RPC server, HTTP routes, or a running assistant.
 *
 * Usage:
 *   ces list
 *   ces get <account>
 *   ces set <account> <value>
 *   ces delete <account>
 *
 * Account format: `credential/<service>/<field>` (e.g. `credential/vellum/platform_organization_id`)
 *
 * Environment variables:
 *   CREDENTIAL_SECURITY_DIR — directory containing `keys.enc` + `store.key`
 *   CES_ASSISTANT_DATA_MOUNT — fallback root for `<mount>/.vellum/protected/`
 *
 * When neither is set, defaults to `~/.vellum/protected/` (local mode).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";

// ---------------------------------------------------------------------------
// Path resolution (mirrors managed-main.ts)
// ---------------------------------------------------------------------------

function resolveVellumRoot(): string {
  const secDir = process.env["CREDENTIAL_SECURITY_DIR"]?.trim();
  if (secDir) {
    // CREDENTIAL_SECURITY_DIR points directly at the dir containing
    // keys.enc, but createLocalSecureKeyBackend wants the parent
    // (.vellum root) and appends /protected/ itself — unless
    // CREDENTIAL_SECURITY_DIR is set, in which case the backend reads
    // from that dir directly. So we pass dirname(secDir) as vellumRoot.
    // Actually, looking at resolveSecurityDir(): if CREDENTIAL_SECURITY_DIR
    // is set it uses that directly, ignoring vellumRoot. So vellumRoot
    // can be anything — the env var takes precedence.
    return join(secDir, "..");
  }

  const mount = process.env["CES_ASSISTANT_DATA_MOUNT"]?.trim();
  if (mount) {
    return join(mount, ".vellum");
  }

  return join(homedir(), ".vellum");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  const vellumRoot = resolveVellumRoot();
  const backend = createLocalSecureKeyBackend(vellumRoot);

  switch (command) {
    case "list": {
      const accounts = await backend.list();
      if (accounts.length === 0) {
        console.log("(no credentials stored)");
      } else {
        for (const account of accounts.sort()) {
          console.log(account);
        }
      }
      break;
    }

    case "get": {
      const account = args[0];
      if (!account) {
        console.error("Usage: ces get <account>");
        process.exit(1);
      }
      const value = await backend.get(account);
      if (value === undefined) {
        console.error(`Not found: ${account}`);
        process.exit(1);
      }
      // Write raw value to stdout (no trailing newline for piping)
      process.stdout.write(value);
      break;
    }

    case "set": {
      const account = args[0];
      const value = args[1];
      if (!account || value === undefined) {
        console.error("Usage: ces set <account> <value>");
        process.exit(1);
      }
      const ok = await backend.set(account, value);
      if (ok) {
        console.log(`Set: ${account}`);
      } else {
        console.error(`Failed to set: ${account}`);
        process.exit(1);
      }
      break;
    }

    case "delete": {
      const account = args[0];
      if (!account) {
        console.error("Usage: ces delete <account>");
        process.exit(1);
      }
      const result = await backend.delete(account);
      if (result === "deleted") {
        console.log(`Deleted: ${account}`);
      } else {
        console.error(`Not found: ${account}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`CES CLI — credential CRUD for the encrypted key store

Usage:
  ces list                     List all credential accounts
  ces get <account>            Get a credential value
  ces set <account> <value>    Set a credential value
  ces delete <account>         Delete a credential

Account format:
  credential/<service>/<field>
  Example: credential/vellum/platform_organization_id

Environment:
  CREDENTIAL_SECURITY_DIR    Directory containing keys.enc + store.key
  CES_ASSISTANT_DATA_MOUNT   Fallback: <mount>/.vellum/protected/`);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
