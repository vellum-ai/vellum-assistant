/**
 * CLI command: `vellum email`
 *
 * Supports:
 *   - `vellum email status`            — show current email configuration
 *   - `vellum email create <username>`  — provision a new email inbox
 */

import { VellumEmailClient } from "../email/vellum.js";
import { loadLatestAssistant } from "../lib/assistant-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function exitError(message: string): void {
  output({ ok: false, error: message });
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage: vellum email <subcommand> [options]

Subcommands:
  status                Show email status (address, inboxes, callback URL)
  create <username>     Create a new email inbox for the given username

Options:
  --assistant <id>      Assistant ID (defaults to the most recently hatched)
  --help, -h            Show this help message
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function email(): Promise<void> {
  const args = process.argv.slice(3); // everything after "email"

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  // Resolve assistant ID from --assistant flag or latest assistant
  const assistantFlagIdx = args.indexOf("--assistant");
  let assistantId: string | undefined;
  if (assistantFlagIdx !== -1) {
    const value = args[assistantFlagIdx + 1];
    if (!value || value.startsWith("-")) {
      exitError("--assistant requires a value.");
      return;
    }
    assistantId = value;
    args.splice(assistantFlagIdx, 2);
  }
  if (!assistantId) {
    assistantId = loadLatestAssistant()?.assistantId;
  }
  if (!assistantId) {
    exitError(
      "No assistant ID available. Pass --assistant <id> or hatch an assistant first.",
    );
    return;
  }

  const subcommand = args[0];

  switch (subcommand) {
    case "status": {
      try {
        const client = new VellumEmailClient(assistantId);
        const addresses = await client.status();
        output({ ok: true, addresses });
      } catch (err) {
        exitError(err instanceof Error ? err.message : String(err));
      }
      break;
    }
    case "create": {
      const username = args[1];
      if (!username) {
        exitError("Usage: vellum email create <username>");
        return;
      }
      try {
        const client = new VellumEmailClient(assistantId);
        const inbox = await client.createInbox(username);
        output({ ok: true, inbox });
      } catch (err) {
        exitError(err instanceof Error ? err.message : String(err));
      }
      break;
    }
    default:
      exitError(`Unknown email subcommand: ${subcommand}`);
      printUsage();
  }
}
