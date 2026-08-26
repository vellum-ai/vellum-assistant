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
  checkPairedAssistantName,
  connectImport as importLegacyBundle,
  pairingCancel,
  pairingPoll,
  pairingStart,
  resolveConfigDir,
} from "@vellumai/local-mode";
import { isRetryablePairingReason } from "@vellumai/service-contracts/remote-web-pairing";

import { extractFlag } from "../../lib/arg-utils.js";
import { getLockfilePaths } from "../../lib/environments/paths.js";
import { getCurrentEnvironment } from "../../lib/environments/resolve.js";
import { STALE_CLI_UPDATE_HINT } from "../../lib/stale-cli-hint.js";

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
    expires (10 minutes). Ctrl-C cancels the attempt. A temporary network
    failure is retried until then rather than ending the attempt.

ARGUMENTS:
    <address>       A pairing link or the assistant's https address. https
                    only; loopback, private-network, and tunnel-provider
                    website addresses are refused.

OPTIONS:
    --name <name>   Local name to register the assistant under, slugified for
                    the id (default: paired-<assistant host>). An existing
                    local assistant of that name is never overwritten;
                    re-importing the same host updates its entry.

EXAMPLES:
    vellum connect import "https://your-assistant.ts.net/assistant/pair#device_code=abc123"
    vellum connect import https://your-assistant.ts.net
    vellum connect import https://your-assistant.ts.net --name desk
`);
}

/** Caps a retry backoff so a long attempt still polls on a useful cadence. */
const MAX_RETRY_BACKOFF_SECONDS = 30;

/**
 * The single place a local registration refusal becomes output. A 409 is a
 * name collision, so it carries the "pick another name" guidance whether it
 * came from the pre-check below or from the import itself.
 */
function formatImportFailure(status: number, error: string): string {
  return status === 409
    ? `Error: ${error} locally. Choose a different --name to avoid overwriting it.`
    : `Error: ${error}`;
}

/** The shared success output of both import paths. */
function reportImported(result: {
  assistantId: string;
  updated: boolean;
  accessOnly: boolean;
}): void {
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
}

/**
 * DEPRECATED input path, kept for one upgrade cycle: a host still on the
 * previous CLI release mints a base64 pairing bundle, and an upgraded second
 * machine would otherwise reject that bundle as an invalid address. Delete
 * this once that release is out of support; nothing mints bundles any more.
 *
 * Returns true when the argument was a bundle and the import is done. A 400
 * means it did not decode as one, so the caller reports the address error it
 * already has instead of a bundle error.
 */
function importLegacyPairingBundle(
  lockfilePaths: string[],
  configDir: string,
  address: string,
  name: string | undefined,
): boolean {
  const result = importLegacyBundle(lockfilePaths, configDir, {
    bundle: address,
    name,
  });
  if (!result.ok) {
    if (result.status === 400) {
      return false;
    }
    console.error(formatImportFailure(result.status, result.error));
    process.exit(1);
  }
  console.log(
    "Warning: base64 pairing bundles are deprecated and will stop working in a future release.",
  );
  console.log(
    "Newer hosts print a pairing link instead: run `vellum pair` there and import that link.",
  );
  console.log("");
  reportImported(result);
  return true;
}

export async function connectImport(): Promise<void> {
  const rawArgs = process.argv.slice(4);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const [nameFlag, args] = extractFlag(rawArgs, "--name");

  // Any `--`-prefixed token left after known-flag extraction is an option this
  // CLI version doesn't support. Fail loud before any network call rather than
  // letting it fall through: an unknown flag would otherwise be read as the
  // address and reported as an unusable one, hiding the real mistake. Neither
  // an https address nor a pairing link starts with `--`.
  const unknownFlag = args.find((a) => a.startsWith("--"));
  if (unknownFlag) {
    console.error(`Error: unknown option '${unknownFlag}'.`);
    console.error(
      "Run `vellum connect import --help` to see available options.",
    );
    console.error(
      `If this option is from newer docs, ${STALE_CLI_UPDATE_HINT}`,
    );
    process.exit(1);
  }

  const address = args[0];
  if (!address) {
    console.error("Error: missing assistant address.");
    printUsage();
    process.exit(1);
  }

  const lockfilePaths = getLockfilePaths(getCurrentEnvironment());
  const configDir = resolveConfigDir(process.env);

  // Refuse a colliding --name BEFORE anything is exchanged. The device code is
  // one-time and the gateway records a device the moment it is spent, so
  // discovering the collision after the exchange would orphan that device and
  // force the user to generate a fresh link. This is a pre-check, not a
  // reservation: another process can still claim the id in between, which the
  // real check inside the import path catches.
  if (nameFlag) {
    const conflict = checkPairedAssistantName(lockfilePaths, nameFlag);
    if (conflict) {
      console.error(formatImportFailure(conflict.status, conflict.error));
      process.exit(1);
    }
  }

  const started = await pairingStart(address);
  if (!started.ok) {
    // The address path runs first, so the normal flow never touches the
    // deprecated bundle decoder; only an unusable address falls through to it.
    if (
      started.reason === "invalid-address" &&
      importLegacyPairingBundle(lockfilePaths, configDir, address, nameFlag)
    ) {
      return;
    }
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

  try {
    if (started.userCode) {
      console.log("Approve this pairing on the assistant's machine:");
      console.log("");
      console.log(`  Code: ${started.userCode}`);
      console.log(`  Run:  vellum pair --web-approve ${started.userCode}`);
      console.log("");
      console.log(`Waiting for approval (expires ${started.expiresAt})...`);
    }

    // The approval wait promises to run until approval or expiry, so a
    // transport failure backs off and polls again rather than abandoning a
    // session local-mode is deliberately keeping alive. Minting the challenge
    // already proved this address reachable, so a later failure is transient.
    //
    // A pairing link is the other case: it opens a session without any
    // request, so nothing has proved the host is up, and there is no approval
    // to wait for. An unreachable host is reported at once there instead of
    // hanging for the link's full TTL.
    const retryTransientFailures = started.userCode !== null;
    let expiresAt = started.expiresAt;
    let intervalSeconds = started.intervalSeconds;
    let consecutiveFailures = 0;

    for (;;) {
      const result = await pairingPoll(lockfilePaths, configDir, {
        handle: started.handle,
        name: nameFlag,
        platform: "cli",
      });

      if (!result.ok) {
        if (
          !retryTransientFailures ||
          !isRetryablePairingReason(result.reason)
        ) {
          console.error(formatImportFailure(result.status, result.error));
          process.exit(1);
        }
        const expiresAtMs = Date.parse(expiresAt);
        if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) {
          console.error(
            "Error: the pairing code expired before the assistant could be " +
              "reached. Start over to get a new one.",
          );
          process.exit(1);
        }
        consecutiveFailures += 1;
        if (consecutiveFailures === 1) {
          console.log("");
          console.log(
            `Could not reach the assistant: ${result.error} ` +
              `Still trying until the code expires (${expiresAt}).`,
          );
        }
        await Bun.sleep(
          Math.min(
            intervalSeconds * consecutiveFailures,
            MAX_RETRY_BACKOFF_SECONDS,
          ) * 1000,
        );
        continue;
      }

      consecutiveFailures = 0;

      if (result.status === "imported") {
        reportImported(result);
        return;
      }

      // Pending: the host has not approved the code yet. The gateway names the
      // deadline and the cadence, and `pairingPoll` reports the attempt expired
      // once that deadline passes.
      expiresAt = result.expiresAt;
      intervalSeconds = result.intervalSeconds;
      await Bun.sleep(intervalSeconds * 1000);
    }
  } finally {
    process.off("SIGINT", cancelPairing);
    process.off("SIGTERM", cancelPairing);
  }
}
