import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { getWorkspaceDirDisplay } from "../../util/platform.js";
import { log } from "../logger.js";

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
  program
    .command("status")
    .description("Show assistant version, workspace, and runtime health")
    .action(async () => {
      const result = await cliIpcCall<HealthResponse>("health");

      if (!result.ok || !result.result) {
        log.error(
          result.error ??
            "Assistant not running — could not connect to IPC socket.",
        );
        process.exit(1);
      }

      const h = result.result;
      const workspace = getWorkspaceDirDisplay();

      const rows: [string, string][] = [
        ["Version", h.version],
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
          log.info("");
          continue;
        }
        log.info(`${label.padEnd(labelWidth)}  ${value}`);
      }
    });
}
