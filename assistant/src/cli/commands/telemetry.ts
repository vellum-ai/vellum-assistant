import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import type { TelemetryFlushSummary } from "../../telemetry/usage-telemetry-reporter.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { telemetryHelp } from "./telemetry.help.js";

function describeSkip(reason: string): string {
  switch (reason) {
    case "nothing-pending":
      return "No pending telemetry events to flush.";
    case "opted-out":
      return "Telemetry flush skipped: analytics sharing is opted out.";
    case "no-credentials":
      return "Telemetry flush skipped: not signed in to the platform yet.";
    case "unknown-consent":
      return "Telemetry flush skipped: consent not yet resolved (will retry).";
    case "checkpoint-unavailable":
      return "Telemetry flush skipped: telemetry store unavailable (will retry).";
    case "disabled":
      return "Telemetry flush skipped: telemetry is disabled.";
    case "post-failed":
      return "Telemetry flush failed: the platform rejected the request.";
    default:
      return `Telemetry flush skipped: ${reason}`;
  }
}

function describeFlushed(r: {
  sent: number;
  persisted: number;
  dropped: number;
}): string {
  const events = r.sent === 1 ? "event" : "events";
  if (r.dropped === 0) {
    return `Flushed ${r.sent} ${events} — all persisted.`;
  }
  return `Flushed ${r.sent} ${events} — ${r.persisted} persisted, ${r.dropped} dropped.`;
}

export function registerTelemetryCommand(program: Command): void {
  registerCommand(program, {
    name: telemetryHelp.name,
    transport: "ipc",
    description: telemetryHelp.description,
    build: (telemetry) => {
      applyCommandHelp(telemetry, telemetryHelp);

      subcommand(telemetry, "flush").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<TelemetryFlushSummary>(
            "telemetry_flush",
            {},
          );
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
          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
            return;
          }
          if (result.flushed) {
            log.info(describeFlushed(result));
          } else {
            log.info(describeSkip(result.reason));
          }
        },
      );
    },
  });
}
