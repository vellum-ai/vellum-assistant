/**
 * `vellum connect import <blob> [--name <localname>]`
 *
 * Import a pairing bundle printed by `vellum pair` on another machine and
 * register it locally so `vellum client`/`message`/`events <name>` work against
 * the remote assistant. Decoding, id derivation, and the lockfile/token writes
 * live in `pairAssistant` (`@vellumai/local-mode`); this command owns only the
 * argv parsing and output copy.
 */

import {
  decodePairBundle,
  pairAssistant,
  resolveConfigDir,
} from "@vellumai/local-mode";

import { extractFlag } from "../../lib/arg-utils.js";
import { getLockfilePaths } from "../../lib/environments/paths.js";
import { getCurrentEnvironment } from "../../lib/environments/resolve.js";

function printUsage(): void {
  console.log(`vellum connect import - Register an assistant paired from another machine

USAGE:
    vellum connect import <bundle> [options]

ARGUMENTS:
    <bundle>    The base64 bundle printed by 'vellum pair' on the host machine

OPTIONS:
    --name <name>   Local name to register the assistant under
                    (default: paired-<deviceId>)

EXAMPLES:
    vellum connect import eyJnYXRld2F5...
    vellum connect import eyJnYXRld2F5... --name desk
`);
}

export async function connectImport(): Promise<void> {
  const rawArgs = process.argv.slice(4);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const [nameFlag, args] = extractFlag(rawArgs, "--name");
  const blob = args[0];
  if (!blob) {
    console.error("Error: missing pairing bundle.");
    printUsage();
    process.exit(1);
  }

  const decoded = decodePairBundle(blob);
  if (!decoded.ok) {
    console.error(
      "Error: invalid pairing bundle. Paste the full base64 string printed by `vellum pair`.",
    );
    process.exit(1);
  }

  const result = pairAssistant(
    getLockfilePaths(getCurrentEnvironment()),
    resolveConfigDir(process.env),
    { bundle: decoded.bundle, name: nameFlag },
  );
  if (!result.ok) {
    if (result.status === 400) {
      console.error(
        "Error: --name must contain at least one alphanumeric character.",
      );
    } else if (result.status === 409) {
      console.error(
        `Error: an assistant named '${result.assistantId}' already exists locally. ` +
          "Choose a different --name to avoid overwriting it.",
      );
    } else {
      console.error(`Error: ${result.error}`);
    }
    process.exit(1);
  }

  console.log(
    `${result.updated ? "Updated" : "Imported"} paired assistant '${result.assistantId}'.`,
  );
  console.log("");
  console.log(`  Connect with:  vellum client ${result.assistantId}`);
  console.log("");
  console.log(
    result.accessOnly
      ? "Note: the token is access-only and will expire. Re-run `vellum pair` and import again when it does."
      : "Note: this connection includes a refresh credential, so it can renew itself. Re-pair only if it's revoked or the refresh credential expires.",
  );
}
