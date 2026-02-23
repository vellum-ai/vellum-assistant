/**
 * CLI command: `vellum email`
 *
 * Supports:
 *   - `vellum email status`            — show current email configuration
 *   - `vellum email create <username>`  — provision a new email inbox
 */

import { createProvider } from "../email/providers/index.js";

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

  const subcommand = args[0];

  switch (subcommand) {
    case "status": {
      try {
        const provider = await createProvider();
        const status = await provider.status();
        output({
          ok: true,
          provider: status.provider,
          inboxes: status.inboxes,
        });
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
        const provider = await createProvider();
        const inbox = await provider.createInbox(username);
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
