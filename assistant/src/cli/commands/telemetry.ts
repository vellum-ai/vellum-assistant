import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { telemetryHelp } from "./telemetry.help.js";

export function registerTelemetryCommand(program: Command): void {
  registerCommand(program, {
    name: telemetryHelp.name,
    transport: "ipc",
    description: telemetryHelp.description,
    build: (telemetry) => {
      applyCommandHelp(telemetry, telemetryHelp);

      subcommand(telemetry, "flush").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<
            { flushed: true } | { flushed: false; reason: string }
          >("telemetry_flush", {});
          if (!r.ok)
            return exitFromIpcResult(
              {
                ok: false,
                error: r.error,
                statusCode: r.statusCode,
              },
              cmd,
            );

          const result = r.result!;
          if (result.flushed) {
            log.info("Telemetry flushed successfully.");
          } else {
            log.info(`Telemetry flush skipped: ${result.reason}`);
          }
        },
      );
    },
  });
}
