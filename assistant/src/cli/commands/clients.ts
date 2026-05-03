import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { optsToQueryParams } from "../lib/ipc-params.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";

interface ClientEntryJSON {
  clientId: string;
  interfaceId: string;
  capabilities: string[];
  machineName?: string;
  connectedAt: string;
  lastActiveAt: string;
}

interface ListClientsResponse {
  clients: ClientEntryJSON[];
}

interface DisconnectClientResponse {
  disconnected: number;
}

export function registerClientsCommand(program: Command): void {
  const clients = program
    .command("clients")
    .description("Discover and manage connected clients");

  clients.addHelpText(
    "after",
    `
Clients are the applications currently connected to the assistant —
macOS desktop, iOS, web, Chrome extension, or CLI. Each client has a
set of capabilities (e.g. host_bash, host_file) that determine which
tools the assistant can route through it.

Examples:
  $ assistant clients list                             List all connected clients
  $ assistant clients list --json                      Machine-readable JSON output
  $ assistant clients list --capability host_bash      Show only clients that can run host commands
  $ assistant clients disconnect <clientId>            Force-disconnect a client`,
  );

  clients
    .command("list")
    .description("List all currently connected clients")
    .option("--json", "Machine-readable compact JSON output")
    .option(
      "--capability <name>",
      "Filter to clients supporting this capability (e.g. host_bash, host_file, host_cu, host_browser, host_app_control)",
    )
    .addHelpText(
      "after",
      `
Options:
  --json                Output as compact JSON instead of a table.
  --capability <name>   Only show clients that support the named capability.
                        Valid values: host_bash, host_file, host_cu, host_browser, host_app_control.

The table shows each client's ID, interface type, capabilities,
connection timestamps, and host environment (when available).
Clients are sorted by most recently connected first.

Examples:
  $ assistant clients list
  $ assistant clients list --capability host_bash
  $ assistant clients list --json | jq '.clients[0].capabilities'`,
    )
    .action(
      async (opts: { json?: boolean; capability?: string }, cmd: Command) => {
        const result = await cliIpcCall<ListClientsResponse>(
          "list_clients",
          optsToQueryParams(opts),
        );

        if (!result.ok) {
          log.error(result.error ?? "Failed to list clients");
          process.exitCode = 1;
          return;
        }

        const response = result.result!;
        const { clients: entries } = response;

        // Sort by most recently connected first
        entries.sort(
          (a, b) =>
            new Date(b.connectedAt).getTime() -
            new Date(a.connectedAt).getTime(),
        );

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
          "LABEL",
          "CONNECTED",
          "LAST ACTIVE",
        ];
        const rows: string[][] = entries.map((e: ClientEntryJSON) => [
          e.clientId,
          e.interfaceId,
          e.capabilities.length > 0 ? e.capabilities.join(", ") : "—",
          e.machineName ?? "—",
          formatRelativeTime(e.connectedAt),
          formatRelativeTime(e.lastActiveAt),
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

  clients
    .command("disconnect <clientId>")
    .description("Force-disconnect a client by its ID")
    .option("--json", "Machine-readable compact JSON output")
    .addHelpText(
      "after",
      `
Arguments:
clientId   The UUID of the client to disconnect (from \`clients list\`).

Force-disposes all hub subscribers for the given client, closing their
SSE streams. The client will observe a broken connection and may
reconnect automatically depending on its implementation.

Examples:
$ assistant clients disconnect a1a30bde-6679-406c-bc32-d5a0d2a7a99e
$ assistant clients disconnect a1a30bde-6679-406c-bc32-d5a0d2a7a99e --json`,
    )
    .action(
      async (clientId: string, opts: { json?: boolean }, cmd: Command) => {
        const result = await cliIpcCall<DisconnectClientResponse>(
          "disconnect_client",
          { body: { clientId } },
        );

        if (!result.ok) {
          log.error(result.error ?? "Failed to disconnect client");
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          writeOutput(cmd, result.result!);
          return;
        }

        log.info(
          `Disconnected client ${clientId} (${result.result!.disconnected} subscriber${result.result!.disconnected === 1 ? "" : "s"} disposed)`,
        );
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
