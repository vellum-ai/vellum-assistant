import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
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

interface ScheduleRunRecord {
  id: string;
  jobId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  output: string | null;
  error: string | null;
  conversationId: string | null;
  createdAt: number;
}

interface ListScheduleRunsResponse {
  runs: ScheduleRunRecord[];
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
Schedules are recurring or one-shot jobs run by the assistant.

This CLI namespace is intentionally landing incrementally. Today it supports
listing schedules, viewing recent run history, and manually executing a schedule
one time, and cancelling pending one-shot schedules; create, delete,
enable/disable, and run inspection will follow as separate slices.

Examples:
  $ assistant schedules list
  $ assistant schedules list --all
  $ assistant schedules runs <schedule-id>
  $ assistant schedules runs <schedule-id> --limit 25 --json
  $ assistant schedules cancel <schedule-id>
  $ assistant schedules execute <schedule-id>`,
      );

      schedules
        .command("list")
        .description("List assistant schedules")
        .option(
          "--all",
          "Include deferred schedules that are hidden by default",
        )
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --all    Include deferred schedules that are normally hidden.
  --json   Output the raw schedule list as compact JSON.

Examples:
  $ assistant schedules list
  $ assistant schedules list --all
  $ assistant schedules list --json`,
        )
        .action(
          async (opts: { all?: boolean; json?: boolean }, cmd: Command) => {
            const queryParams: Record<string, string> = {};
            if (opts.all) queryParams.include_all = "true";

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

      schedules
        .command("runs <id>")
        .description("List recent runs for a schedule")
        .option("--limit <count>", "Max runs to return (default 10, max 100)")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --limit <count>   Max runs to return. The assistant clamps values to 1-100.
  --json            Output the raw run list as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list' to find it.

Examples:
  $ assistant schedules runs 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules runs 9f2c4f3a-3f1a-41e4-88e7-abc123 --limit 25
  $ assistant schedules runs 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        )
        .action(
          async (
            id: string,
            opts: { limit?: string; json?: boolean },
            cmd: Command,
          ) => {
            const scheduleId = id.trim();
            const queryParams: Record<string, string> = {};
            if (opts.limit != null) queryParams.limit = opts.limit;

            const result = await cliIpcCall<ListScheduleRunsResponse>(
              "listScheduleRuns",
              { pathParams: { id: scheduleId }, queryParams },
            );

            if (!result.ok) return exitFromIpcResult(result, cmd);

            const response = result.result ?? { runs: [] };
            if (opts.json) {
              writeOutput(cmd, response);
              return;
            }

            const runs = response.runs;
            if (runs.length === 0) {
              log.info(`No runs found for schedule ${scheduleId}.`);
              return;
            }

            const rows = runs.map((run) => ({
              id: run.id,
              status: run.status,
              startedAt: formatTimestamp(run.startedAt),
              finishedAt: formatNullableTimestamp(run.finishedAt),
              duration: formatDuration(run.durationMs),
              conversation: run.conversationId ?? "—",
              error: run.error ?? "—",
            }));

            const headers = [
              "ID",
              "STATUS",
              "STARTED",
              "FINISHED",
              "DURATION",
              "CONVERSATION",
              "ERROR",
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
              widths[1] = Math.max(widths[1], row.status.length);
              widths[2] = Math.max(widths[2], row.startedAt.length);
              widths[3] = Math.max(widths[3], row.finishedAt.length);
              widths[4] = Math.max(widths[4], row.duration.length);
              widths[5] = Math.max(widths[5], row.conversation.length);
              widths[6] = Math.max(widths[6], row.error.length);
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
                  row.status,
                  row.startedAt,
                  row.finishedAt,
                  row.duration,
                  row.conversation,
                  row.error,
                ]
                  .map((value, index) => pad(value, widths[index]!))
                  .join("  "),
              );
            }
          },
        );

      schedules
        .command("cancel <id>")
        .description("Cancel a pending one-shot schedule")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --json   Output the updated schedule list as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list --all' to find
         pending one-shot/deferred schedules.

Behavior:
  Cancels a pending one-shot schedule. Recurring schedules are not cancellable;
  use enable/disable commands once those CLI slices land.

Examples:
  $ assistant schedules cancel 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules cancel 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        )
        .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
          const scheduleId = id.trim();
          const result = await cliIpcCall<ListSchedulesResponse>(
            "cancelSchedule",
            { pathParams: { id: scheduleId } },
          );

          if (!result.ok) return exitFromIpcResult(result, cmd);

          const response = result.result ?? { schedules: [] };
          if (opts.json) {
            writeOutput(cmd, response);
            return;
          }

          log.info(`Cancelled schedule: ${scheduleId}`);
        });

      schedules
        .command("execute <id>")
        .description("Execute a schedule one time immediately")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --json   Output the run-now result as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list' to find it.

Examples:
  $ assistant schedules execute 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules execute 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        )
        .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
          const scheduleId = id.trim();
          if (!scheduleId) {
            const error = "Schedule ID is required";
            if (opts.json) {
              writeOutput(cmd, { ok: false, error });
            } else {
              log.error(error);
            }
            process.exitCode = 1;
            return;
          }

          const result = await cliIpcCall<ListSchedulesResponse>(
            "runScheduleNow",
            { pathParams: { id: scheduleId } },
          );

          if (!result.ok) return exitFromIpcResult(result, cmd);

          const response = result.result ?? { schedules: [] };
          const schedule = response.schedules.find(
            (entry) => entry.id === scheduleId,
          );

          if (opts.json) {
            writeOutput(cmd, response);
            return;
          }

          if (schedule) {
            log.info(`Executed schedule: ${schedule.name} (${schedule.id})`);
            if (schedule.lastStatus) {
              log.info(`Last status: ${schedule.lastStatus}`);
            }
            return;
          }

          log.info(`Executed schedule: ${scheduleId}`);
        });
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

function formatNullableTimestamp(value: number | null): string {
  return value == null ? "—" : formatTimestamp(value);
}

function formatDuration(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value}ms`;
}
