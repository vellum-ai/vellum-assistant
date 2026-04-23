import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type { ClientEntryJSON } from "../../runtime/client-registry.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";

interface ListClientsResponse {
  clients: ClientEntryJSON[];
}

export function registerClientsCommand(program: Command): void {
  const clients = program
    .command("clients")
    .description("Discover connected clients and their capabilities");

  clients.addHelpText(
    "after",
    `
Clients are the applications currently connected to the assistant —
macOS desktop, iOS, web, Chrome extension, or CLI. Each client has a
set of capabilities (e.g. host_bash, host_file) that determine which
tools the assistant can route through it.

Examples:
  $ assistant clients list                       List all connected clients
  $ assistant clients list --json                Machine-readable JSON output
  $ assistant clients list --capability host_bash  Show only clients that can run host commands`,
  );

  clients
    .command("list")
    .description("List all currently connected clients")
    .option("--json", "Machine-readable compact JSON output")
    .option(
      "--capability <name>",
      "Filter to clients supporting this capability (e.g. host_bash, host_file, host_cu, host_browser)",
    )
    .addHelpText(
      "after",
      `
Options:
  --json                Output as compact JSON instead of a table.
  --capability <name>   Only show clients that support the named capability.
                        Valid values: host_bash, host_file, host_cu, host_browser.

The table shows each client's ID, interface type, capabilities,
connection timestamps, and host environment (when available).
Clients are sorted by most recently active first.

Examples:
  $ assistant clients list
  $ assistant clients list --capability host_bash
  $ assistant clients list --json | jq '.clients[0].capabilities'`,
    )
    .action(
      async (opts: { json?: boolean; capability?: string }, cmd: Command) => {
        const params: Record<string, unknown> = {};
        if (opts.capability) {
          params.capability = opts.capability;
        }

        const result = await cliIpcCall<ListClientsResponse>(
          "list_clients",
          Object.keys(params).length > 0 ? params : undefined,
        );

        if (!result.ok) {
          log.error(result.error ?? "Failed to list clients");
          process.exitCode = 1;
          return;
        }

        const response = result.result!;
        const { clients: entries } = response;

        if (opts.json) {
          writeOutput(cmd, response);
          return;
        }

        if (entries.length === 0) {
          log.info("No clients connected.");
          return;
        }

        // Table output
        const header = [
          "CLIENT ID",
          "INTERFACE",
          "CAPABILITIES",
          "CONNECTED",
          "LAST ACTIVE",
          "HOST",
        ];
        const rows: string[][] = entries.map((e: ClientEntryJSON) => [
          e.clientId.length > 20 ? `${e.clientId.slice(0, 17)}...` : e.clientId,
          e.interfaceId,
          e.capabilities.length > 0 ? e.capabilities.join(", ") : "—",
          formatRelativeTime(e.connectedAt),
          formatRelativeTime(e.lastActiveAt),
          e.hostUsername
            ? `${e.hostUsername}${e.hostHomeDir ? ` (${e.hostHomeDir})` : ""}`
            : "—",
        ]);

        // Calculate column widths
        const colWidths = header.map((h: string, i: number) =>
          Math.max(h.length, ...rows.map((r: string[]) => r[i].length)),
        );

        const pad = (s: string, w: number) => s.padEnd(w);
        const line = header
          .map((h: string, i: number) => pad(h, colWidths[i]))
          .join("  ");
        log.info(line);
        log.info(colWidths.map((w: number) => "─".repeat(w)).join("  "));
        for (const row of rows) {
          log.info(
            row.map((c: string, i: number) => pad(c, colWidths[i])).join("  "),
          );
        }
      },
    );
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
