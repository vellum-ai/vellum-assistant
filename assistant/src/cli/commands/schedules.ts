import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";

interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  syntax: string;
  expression: string | null;
  cronExpression: string | null;
  timezone: string | null;
  message: string;
  script: string | null;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  retryCount: number;
  maxRetries: number;
  retryBackoffMs: number;
  description: string | null;
  mode: string;
  status: string;
  routingIntent: string;
  reuseConversation: boolean;
  wakeConversationId: string | null;
  isOneShot: boolean;
}

interface ListSchedulesResponse {
  schedules: ScheduleRecord[];
}

export function registerSchedulesCommand(program: Command): void {
  registerCommand(program, {
    name: "schedules",
    transport: "ipc",
    description: "Manage scheduled jobs",
    build: (schedules) => {
      schedules.addHelpText(
        "after",
        `
Schedules are recurring or one-shot jobs run by the assistant daemon.

This CLI namespace is intentionally landing incrementally. Today it supports
listing schedules; run/execute, create, delete, enable/disable, run history,
and run inspection will follow as separate slices.

Examples:
  $ assistant schedules list
  $ assistant schedules list --include-all
  $ assistant schedules list --json`,
      );

      schedules
        .command("list")
        .description("List assistant schedules")
        .option(
          "--include-all",
          "Include deferred schedules that are hidden by default",
        )
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --include-all   Include deferred schedules that are normally hidden.
  --json          Output the raw schedule list as compact JSON.

Examples:
  $ assistant schedules list
  $ assistant schedules list --include-all
  $ assistant schedules list --json`,
        )
        .action(
          async (
            opts: { includeAll?: boolean; json?: boolean },
            cmd: Command,
          ) => {
            const queryParams: Record<string, string> = {};
            if (opts.includeAll) queryParams.include_all = "true";

            const result = await cliIpcCall<ListSchedulesResponse>(
              "listSchedules",
              { queryParams },
            );

            if (!result.ok) {
              if (opts.json) {
                writeOutput(cmd, { ok: false, error: result.error });
              } else {
                log.error(result.error ?? "Failed to list schedules");
              }
              process.exitCode = 1;
              return;
            }

            const response = result.result ?? { schedules: [] };
            const entries = [...response.schedules].sort(
              (a, b) => a.nextRunAt - b.nextRunAt,
            );

            if (opts.json) {
              writeOutput(cmd, { schedules: entries });
              return;
            }

            if (entries.length === 0) {
              log.info("No schedules found.");
              return;
            }

            const rows = entries.map((schedule) => ({
              id: schedule.id,
              name: schedule.name,
              enabled: schedule.enabled ? "enabled" : "disabled",
              mode: schedule.mode,
              schedule: describeSchedule(schedule),
              nextRun: formatTimestamp(schedule.nextRunAt),
              lastStatus: schedule.lastStatus ?? "—",
            }));

            const headers = [
              "ID",
              "NAME",
              "ENABLED",
              "MODE",
              "SCHEDULE",
              "NEXT RUN",
              "LAST STATUS",
            ];
            const widths = [
              headers[0].length,
              headers[1].length,
              headers[2].length,
              headers[3].length,
              headers[4].length,
              headers[5].length,
              headers[6].length,
            ];

            for (const row of rows) {
              widths[0] = Math.max(widths[0], row.id.length);
              widths[1] = Math.max(widths[1], row.name.length);
              widths[2] = Math.max(widths[2], row.enabled.length);
              widths[3] = Math.max(widths[3], row.mode.length);
              widths[4] = Math.max(widths[4], row.schedule.length);
              widths[5] = Math.max(widths[5], row.nextRun.length);
              widths[6] = Math.max(widths[6], row.lastStatus.length);
            }

            const pad = (value: string, width: number) => value.padEnd(width);
            log.info(
              headers
                .map((header, index) => pad(header, widths[index]!))
                .join("  "),
            );
            log.info(widths.map((width) => "─".repeat(width)).join("  "));
            for (const row of rows) {
              log.info(
                [
                  row.id,
                  row.name,
                  row.enabled,
                  row.mode,
                  row.schedule,
                  row.nextRun,
                  row.lastStatus,
                ]
                  .map((value, index) => pad(value, widths[index]!))
                  .join("  "),
              );
            }
          },
        );
    },
  });
}

function describeSchedule(schedule: ScheduleRecord): string {
  if (schedule.isOneShot) return "one-shot";
  const expression = schedule.description ?? schedule.expression ?? "—";
  return schedule.timezone
    ? `${expression} (${schedule.timezone})`
    : expression;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toISOString();
}
