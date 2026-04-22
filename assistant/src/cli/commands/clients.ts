import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type { ClientEntryJSON } from "../../runtime/client-registry.js";
import { writeOutput } from "../output.js";

interface ListClientsResponse {
  clients: ClientEntryJSON[];
}

export function registerClientsCommand(program: Command): void {
  const clients = program
    .command("clients")
    .description("Discover connected clients and their capabilities");

  clients
    .command("list")
    .description("List all currently connected clients")
    .option("--json", "Machine-readable compact JSON output")
    .option(
      "--capability <name>",
      "Filter to clients supporting this capability (e.g. host_bash, host_file, host_cu, host_browser)",
    )
    .action(async (opts: { json?: boolean; capability?: string }) => {
      const params: Record<string, unknown> = {};
      if (opts.capability) {
        params.capability = opts.capability;
      }

      const result = await cliIpcCall<ListClientsResponse>(
        "list_clients",
        Object.keys(params).length > 0 ? params : undefined,
      );

      if (!result.ok) {
        writeOutput({ error: result.error }, { json: opts.json });
        process.exitCode = 1;
        return;
      }

      const { clients: entries } = result.data;

      if (opts.json) {
        writeOutput(result.data, { json: true });
        return;
      }

      if (entries.length === 0) {
        console.log("No clients connected.");
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
      const rows = entries.map((e) => [
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
      const colWidths = header.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => r[i].length)),
      );

      const pad = (s: string, w: number) => s.padEnd(w);
      const line = header.map((h, i) => pad(h, colWidths[i])).join("  ");
      console.log(line);
      console.log(colWidths.map((w) => "─".repeat(w)).join("  "));
      for (const row of rows) {
        console.log(row.map((c, i) => pad(c, colWidths[i])).join("  "));
      }
    });
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
