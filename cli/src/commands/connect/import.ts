/**
 * `vellum connect import <address> [--name <localname>]`
 *
 * Pair this machine with an assistant running elsewhere and register it
 * locally so `vellum client`/`message`/`events <name>` work against it. The
 * device-code exchange, the lockfile write, and the token write live in
 * `pairingStart`/`pairingPoll` (`@vellumai/local-mode`); this command owns the
 * argv parsing, the polling cadence, and the output copy.
 */

import {
  pairingCancel,
  pairingPoll,
  pairingStart,
  resolveConfigDir,
} from "@vellumai/local-mode";

import { extractFlag } from "../../lib/arg-utils.js";
import { getLockfilePaths } from "../../lib/environments/paths.js";
import { getCurrentEnvironment } from "../../lib/environments/resolve.js";

function printUsage(): void {
  console.log(`vellum connect import - Pair with an assistant running on another machine

USAGE:
    vellum connect import <address> [options]

Registers the assistant at <address> on this machine: a lockfile entry plus a
guardian token, both under the local name below. The pairing is a device of
its own on the host, listed and separately revocable there.

<address> is either form of pairing artifact:

    A pairing link from 'vellum pair' (or the host's Pair a device card). It
    carries an approved device code, so the import completes right away.

    The assistant's public https address, e.g. https://your-assistant.ts.net.
    This machine mints its own pairing code, prints it, and polls until the
    code is approved on the host with 'vellum pair --web-approve <code>' or
    expires (10 minutes). Ctrl-C cancels the attempt.

ARGUMENTS:
    <address>       A pairing link or the assistant's https address. https
                    only; loopback, private-network, and tunnel-provider
                    website addresses are refused.

OPTIONS:
    --name <name>   Local name to register the assistant under, slugified for
                    the id (default: paired-<deviceId>). An existing local
                    assistant of that name is never overwritten.

EXAMPLES:
    vellum connect import "https://your-assistant.ts.net/assistant/pair#device_code=abc123"
    vellum connect import https://your-assistant.ts.net
    vellum connect import https://your-assistant.ts.net --name desk
`);
}

export async function connectImport(): Promise<void> {
  const rawArgs = process.argv.slice(4);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const [nameFlag, args] = extractFlag(rawArgs, "--name");
  const address = args[0];
  if (!address) {
    console.error("Error: missing assistant address.");
    printUsage();
    process.exit(1);
  }

  const started = await pairingStart(address);
  if (!started.ok) {
    console.error(`Error: ${started.error}`);
    process.exit(1);
  }

  // An interrupted wait drops the pending session rather than leaving the
  // device code exchangeable for the rest of its TTL.
  const cancelPairing = (): void => {
    pairingCancel(started.handle);
    process.exit(130);
  };
  process.on("SIGINT", cancelPairing);
  process.on("SIGTERM", cancelPairing);

  const lockfilePaths = getLockfilePaths(getCurrentEnvironment());
  const configDir = resolveConfigDir(process.env);

  try {
    if (started.userCode) {
      console.log("Approve this pairing on the assistant's machine:");
      console.log("");
      console.log(`  Code: ${started.userCode}`);
      console.log(`  Run:  vellum pair --web-approve ${started.userCode}`);
      console.log("");
      console.log(`Waiting for approval (expires ${started.expiresAt})...`);
    }

    for (;;) {
      const result = await pairingPoll(lockfilePaths, configDir, {
        handle: started.handle,
        name: nameFlag,
        platform: "cli",
      });

      if (!result.ok) {
        console.error(
          result.status === 409
            ? `Error: ${result.error} locally. Choose a different --name to avoid overwriting it.`
            : `Error: ${result.error}`,
        );
        process.exit(1);
      }

      if (result.status === "imported") {
        console.log(
          `${result.updated ? "Updated" : "Imported"} paired assistant '${result.assistantId}'.`,
        );
        console.log("");
        console.log(`  Connect with:  vellum client ${result.assistantId}`);
        console.log("");
        console.log(
          result.accessOnly
            ? "Note: the assistant issued an access-only token, so this connection will expire. Run `vellum connect import` again with a fresh pairing link when it does."
            : "Note: this connection includes a refresh credential, so it can renew itself. Re-pair only if it's revoked or the refresh credential expires.",
        );
        return;
      }

      // Pending: the host has not approved the code yet. `pairingPoll` reports
      // the attempt expired once its deadline passes, so the wait is bounded
      // without a second expiry clock here.
      await Bun.sleep(result.intervalSeconds * 1000);
    }
  } finally {
    process.off("SIGINT", cancelPairing);
    process.off("SIGTERM", cancelPairing);
  }
}
