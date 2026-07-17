import { existsSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { getAssistantSocketPath } from "../../ipc/socket-path.js";
import { getWorkspaceDirDisplay } from "../../util/platform.js";
import { APP_VERSION } from "../../version.js";
import { applyCommandHelp } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { statusHelp } from "./status.help.js";

interface HealthResponse {
  version: string;
  memory: { currentMb: number; maxMb: number };
  disk: { freeMb: number; totalMb: number } | null;
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function registerStatusCommand(program: Command): void {
  registerCommand(program, {
    name: statusHelp.name,
    transport: "ipc",
    description: statusHelp.description,
    build: (cmd) => {
      applyCommandHelp(cmd, statusHelp);

      cmd.action(async () => {
        const json = shouldOutputJson(cmd);
        const result = await cliIpcCall<HealthResponse>("health");

        if (!result.ok) {
          // Only ENOENT/ECONNREFUSED/connect-timeout produce this prefix; other
          // failures (daemon-side error, framing error, abort) are real failures.
          if (
            result.error?.startsWith("Could not connect to the assistant at ")
          ) {
            const socketPath = getAssistantSocketPath();
            const socketExists = existsSync(socketPath);
            const workspace = getWorkspaceDirDisplay();
            if (json) {
              writeOutput(cmd, {
                reachable: false,
                cliVersion: APP_VERSION,
                assistantVersion: null,
                versionStale: false,
                running: socketExists,
                workspace,
                memory: null,
                disk: null,
              });
              process.exit(0);
            }
            // Daemon unreachable, so its runtime version is unknown; show the
            // installed CLI version so there's always one reliable number.
            process.stdout.write(`CLI Version: ${APP_VERSION}\n`);
            process.stdout.write(
              (socketExists ? "Assistant: running" : "Assistant: down") + "\n",
            );
            process.stdout.write(`Workspace: ${workspace}\n`);
            process.exit(0);
          }
          process.stderr.write((result.error ?? "health check failed") + "\n");
          process.exit(1);
        }

        if (!result.result) {
          process.stderr.write("health check returned empty response\n");
          process.exit(1);
        }

        const h = result.result;
        const workspace = getWorkspaceDirDisplay();

        if (json) {
          writeOutput(cmd, {
            reachable: true,
            cliVersion: APP_VERSION,
            assistantVersion: h.version,
            versionStale: h.version !== APP_VERSION,
            running: true,
            workspace,
            memory: h.memory,
            disk: h.disk,
          });
          return;
        }

        // h.version is the running runtime; APP_VERSION is the installed CLI.
        // They drift mid-upgrade (CLI bumped, daemon not yet restarted).
        const runtimeVersion =
          h.version === APP_VERSION
            ? h.version
            : `${h.version} (stale — restart to run ${APP_VERSION})`;

        const rows: [string, string][] = [
          ["Assistant Version", runtimeVersion],
          ["Workspace", workspace],
          ["", ""],
          ["Memory", `${fmtMb(h.memory.currentMb)} / ${fmtMb(h.memory.maxMb)}`],
          ...(h.disk
            ? ([["Disk", `${fmtMb(h.disk.freeMb)} free`]] as [string, string][])
            : []),
        ];

        const labelWidth = Math.max(
          ...rows.filter(([l]) => l).map(([l]) => l.length),
        );
        for (const [label, value] of rows) {
          if (!label) {
            process.stdout.write("\n");
            continue;
          }
          process.stdout.write(`${label.padEnd(labelWidth)}  ${value}\n`);
        }
      });
    },
  });
}
