import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { optsToQueryParams } from "../lib/ipc-params.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";
import { clientsHelp } from "./clients.help.js";

interface ClientEntryJSON {
  clientId: string;
  interfaceId: string;
  capabilities: string[];
  machineName?: string;
  connectedAt: string;
  lastActiveAt: string;
  degraded?: boolean;
}

interface ListClientsResponse {
  clients: ClientEntryJSON[];
}

interface DisconnectClientResponse {
  disconnected: number;
}

export function registerClientsCommand(program: Command): void {
  registerCommand(program, {
    name: clientsHelp.name,
    transport: "ipc",
    description: clientsHelp.description,
    build: (clients) => {
      applyCommandHelp(clients, clientsHelp);

      subcommand(clients, "list").action(
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
            "STATUS",
          ];
          const rows: string[][] = entries.map((e: ClientEntryJSON) => [
            e.clientId,
            e.interfaceId,
            e.capabilities.length > 0 ? e.capabilities.join(", ") : "—",
            e.machineName ?? "—",
            formatRelativeTime(e.connectedAt),
            formatRelativeTime(e.lastActiveAt),
            e.degraded ? "degraded" : "—",
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
              row
                .map((c: string, i: number) => pad(c, colWidths[i]))
                .join("  "),
            );
          }
        },
      );

      subcommand(clients, "disconnect").action(
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
    },
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
