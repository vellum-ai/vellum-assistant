/**
 * `vellum unpair <name>`
 *
 * Forget a pairing imported from another machine via `vellum connect import`:
 * remove its lockfile entry and stored guardian token from THIS machine. Only
 * paired assistants (`cloud: "paired"`) can be unpaired — `vellum retire` owns
 * local and managed assistants.
 *
 * This is client-side only: it forgets the connection here but does not revoke
 * the device on the host. (Host-side revocation is `vellum devices`.)
 */

import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
  removeAssistantEntry,
} from "../lib/assistant-config";
import { deleteGuardianToken } from "../lib/guardian-token";

function printUsage(): void {
  console.log(`vellum unpair - Forget a paired assistant imported from another machine

USAGE:
    vellum unpair <name>

ARGUMENTS:
    <name>    Name or id of the paired assistant to forget

Removes the local connection (lockfile entry + stored token). Only paired
assistants (imported via 'vellum connect import') can be unpaired; use
'vellum retire' for local or managed assistants.`);
}

export async function unpair(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("Error: assistant name or id is required.");
    printUsage();
    process.exit(1);
  }

  const lookup = lookupAssistantByIdentifier(name);
  if (lookup.status !== "found") {
    console.error(formatAssistantLookupError(name, lookup));
    process.exit(1);
  }
  const entry = lookup.entry;

  if (entry.cloud !== "paired") {
    console.error(
      `Error: '${name}' is not a paired assistant. Use \`vellum retire\` to remove a local or managed assistant.`,
    );
    process.exit(1);
  }

  removeAssistantEntry(entry.assistantId);
  deleteGuardianToken(entry.assistantId);

  console.log(
    `Unpaired '${name}' — removed the local connection (lockfile entry + token).`,
  );
  console.log("");
  console.log(
    "Note: this only forgets the connection on this machine. The assistant's host can fully revoke this device from its side.",
  );
}
