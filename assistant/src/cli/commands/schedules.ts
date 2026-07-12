import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { formatCostUsd } from "../lib/cli-output.js";
import { confirmPrompt } from "../lib/confirm-prompt.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";
import { schedulesHelp } from "./schedules.help.js";
import { registerSchedulesWorkerCommand } from "./schedules-worker.js";

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
  timeoutMs: number | null;
  inferenceProfile: string | null;
  createdFromConversationId: string | null;
  description: string | null;
  cadenceDescription: string | null;
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

interface GetScheduleResponse {
  schedule: ScheduleRecord;
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
  estimatedCostUsd: number;
  createdAt: number;
}

interface ListScheduleRunsResponse {
  runs: ScheduleRunRecord[];
}

export function registerSchedulesCommand(program: Command): void {
  registerCommand(program, {
    name: schedulesHelp.name,
    transport: "ipc",
    description: schedulesHelp.description,
    build: (schedules) => {
      applyCommandHelp(schedules, schedulesHelp);

      subcommand(schedules, "list").action(
        async (opts: { all?: boolean; json?: boolean }, cmd: Command) => {
          const queryParams: Record<string, string> = {};
          if (opts.all) {
            queryParams.include_all = "true";
          }

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

      subcommand(schedules, "get")
        .alias("inspect")
        .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
          const scheduleId = id.trim();
          const result = await cliIpcCall<GetScheduleResponse>("getSchedule", {
            pathParams: { id: scheduleId },
          });

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

          const schedule = result.result?.schedule;
          if (!schedule) {
            const error = `Schedule "${scheduleId}" not found. Run 'assistant schedules list --all' to see available schedules.`;
            if (opts.json) {
              writeOutput(cmd, { ok: false, error });
            } else {
              log.error(error);
            }
            process.exitCode = 1;
            return;
          }

          if (opts.json) {
            writeOutput(cmd, { schedule });
            return;
          }

          const fields: Array<[string, string]> = [
            ["ID", schedule.id],
            ["Name", schedule.name],
            ["Description", schedule.description ?? "—"],
            ["Enabled", schedule.enabled ? "enabled" : "disabled"],
            ["Status", schedule.status],
            ["Mode", schedule.mode],
            ["Syntax", schedule.syntax],
            ["Expression", schedule.expression ?? "—"],
            ["Cadence", describeSchedule(schedule)],
            ["Timezone", schedule.timezone ?? "—"],
            ["Next run", formatTimestamp(schedule.nextRunAt)],
            ["Last run", formatNullableTimestamp(schedule.lastRunAt)],
            ["Last status", schedule.lastStatus ?? "—"],
            ["One-shot", schedule.isOneShot ? "yes" : "no"],
            ["Message", schedule.message || "—"],
            ["Script", schedule.script ?? "—"],
            [
              "Inference profile",
              schedule.inferenceProfile ?? "default (mainAgent)",
            ],
            ["Routing intent", schedule.routingIntent],
            ["Reuse conversation", schedule.reuseConversation ? "yes" : "no"],
            ["Wake conversation", schedule.wakeConversationId ?? "—"],
            ["Retry count", String(schedule.retryCount)],
            ["Max retries", String(schedule.maxRetries)],
            ["Retry backoff", formatDuration(schedule.retryBackoffMs)],
            ["Timeout", formatDuration(schedule.timeoutMs)],
            ["Source conversation", schedule.createdFromConversationId ?? "—"],
          ];
          const labelWidth = Math.max(...fields.map(([label]) => label.length));
          for (const [label, value] of fields) {
            log.info(`${`${label}:`.padEnd(labelWidth + 2)}${value}`);
          }
        });

      subcommand(schedules, "runs").action(
        async (
          id: string,
          opts: { limit?: string; json?: boolean },
          cmd: Command,
        ) => {
          const scheduleId = id.trim();
          const queryParams: Record<string, string> = {};
          if (opts.limit != null) {
            queryParams.limit = opts.limit;
          }

          const result = await cliIpcCall<ListScheduleRunsResponse>(
            "listScheduleRuns",
            { pathParams: { id: scheduleId }, queryParams },
          );

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

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
            cost: formatRunCost(run.estimatedCostUsd),
            conversation: run.conversationId ?? "—",
            error: run.error ?? "—",
          }));

          const headers = [
            "ID",
            "STATUS",
            "STARTED",
            "FINISHED",
            "DURATION",
            "COST",
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
            headers[7].length,
          ];

          for (const row of rows) {
            widths[0] = Math.max(widths[0], row.id.length);
            widths[1] = Math.max(widths[1], row.status.length);
            widths[2] = Math.max(widths[2], row.startedAt.length);
            widths[3] = Math.max(widths[3], row.finishedAt.length);
            widths[4] = Math.max(widths[4], row.duration.length);
            widths[5] = Math.max(widths[5], row.cost.length);
            widths[6] = Math.max(widths[6], row.conversation.length);
            widths[7] = Math.max(widths[7], row.error.length);
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
                row.cost,
                row.conversation,
                row.error,
              ]
                .map((value, index) => pad(value, widths[index]!))
                .join("  "),
            );
          }
        },
      );

      subcommand(schedules, "create").action(
        async (
          name: string,
          opts: {
            expression: string;
            description: string;
            message?: string;
            mode?: string;
            script?: string;
            timeoutMs?: string;
            timezone?: string;
            profile?: string;
            enabled: boolean;
            json?: boolean;
          },
          cmd: Command,
        ) => {
          const scheduleName = name.trim();
          if (!scheduleName) {
            const error = "name is required";
            if (opts.json) {
              writeOutput(cmd, { ok: false, error });
            } else {
              log.error(error);
            }
            process.exitCode = 1;
            return;
          }

          const description = opts.description.trim();
          if (!description) {
            const error = "description is required";
            if (opts.json) {
              writeOutput(cmd, { ok: false, error });
            } else {
              log.error(error);
            }
            process.exitCode = 1;
            return;
          }

          const mode = opts.mode ?? "execute";
          if (mode === "script" && !opts.script) {
            const error = "--script is required for --mode script";
            if (opts.json) {
              writeOutput(cmd, { ok: false, error });
            } else {
              log.error(error);
            }
            process.exitCode = 1;
            return;
          }
          if (mode === "execute" && !opts.message) {
            const error = "--message is required for execute mode";
            if (opts.json) {
              writeOutput(cmd, { ok: false, error });
            } else {
              log.error(error);
            }
            process.exitCode = 1;
            return;
          }

          const body: Record<string, unknown> = {
            name: scheduleName,
            expression: opts.expression,
            description,
            enabled: opts.enabled,
          };
          // Omit mode for the default; the route treats absent as 'execute'.
          if (mode !== "execute") {
            body.mode = mode;
          }
          if (opts.message != null) {
            body.message = opts.message;
          }
          if (opts.script != null) {
            body.script = opts.script;
          }
          if (opts.timeoutMs != null) {
            body.timeoutMs = Number(opts.timeoutMs);
          }
          if (opts.timezone != null) {
            body.timezone = opts.timezone;
          }
          if (opts.profile != null) {
            body.inferenceProfile = opts.profile;
          }

          const result = await cliIpcCall<GetScheduleResponse>(
            "createSchedule",
            { body },
          );

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

          if (opts.json) {
            writeOutput(cmd, result.result ?? {});
            return;
          }

          log.info(`Created schedule: ${scheduleName}`);
        },
      );

      subcommand(schedules, "update").action(
        async (
          id: string,
          opts: {
            name?: string;
            description?: string;
            expression?: string;
            timezone?: string;
            message?: string;
            script?: string;
            mode?: string;
            routingIntent?: string;
            quiet?: boolean;
            reuseConversation?: boolean;
            maxRetries?: string;
            retryBackoffMs?: string;
            timeoutMs?: string;
            clearTimeout?: boolean;
            profile?: string;
            clearProfile?: boolean;
            json?: boolean;
          },
          cmd: Command,
        ) => {
          const scheduleId = id.trim();
          const fail = (error: string) => {
            if (opts.json) {
              writeOutput(cmd, { ok: false, error });
            } else {
              log.error(error);
            }
            process.exitCode = 1;
          };

          const parseInteger = (flag: string, value: string): number | null => {
            const parsed = Number(value);
            if (!Number.isInteger(parsed)) {
              fail(`${flag} must be an integer, got "${value}"`);
              return null;
            }
            return parsed;
          };

          if (opts.clearTimeout && opts.timeoutMs != null) {
            fail(
              "--timeout-ms and --clear-timeout are mutually exclusive; pass --timeout-ms to set a timeout or --clear-timeout to remove it",
            );
            return;
          }

          if (opts.clearProfile && opts.profile != null) {
            fail(
              "--profile and --clear-profile are mutually exclusive; pass --profile to set a profile or --clear-profile to revert to the default mainAgent model selection",
            );
            return;
          }

          // Wake mode requires a wake conversation target, which this CLI
          // cannot set. Allow `--mode wake` only when the schedule already
          // has one — otherwise the scheduler would skip every fire as a
          // no-op.
          if (opts.mode === "wake") {
            const existing = await cliIpcCall<GetScheduleResponse>(
              "getSchedule",
              { pathParams: { id: scheduleId } },
            );
            if (!existing.ok) {
              return exitFromIpcResult(existing, cmd);
            }
            if (!existing.result?.schedule.wakeConversationId) {
              fail(
                "--mode wake requires the schedule to already have a wake conversation target; this CLI cannot set one. Create wake schedules with the schedule tool instead.",
              );
              return;
            }
          }

          const body: Record<string, unknown> = {};
          if (opts.name != null) {
            body.name = opts.name;
          }
          if (opts.description != null) {
            body.description = opts.description;
          }
          if (opts.expression != null) {
            body.expression = opts.expression;
          }
          if (opts.timezone != null) {
            body.timezone = opts.timezone;
          }
          if (opts.message != null) {
            body.message = opts.message;
          }
          if (opts.script != null) {
            body.script = opts.script;
          }
          if (opts.mode != null) {
            body.mode = opts.mode;
          }
          if (opts.routingIntent != null) {
            body.routingIntent = opts.routingIntent;
          }
          if (opts.quiet != null) {
            body.quiet = opts.quiet;
          }
          if (opts.reuseConversation != null) {
            body.reuseConversation = opts.reuseConversation;
          }
          if (opts.maxRetries != null) {
            const parsed = parseInteger("--max-retries", opts.maxRetries);
            if (parsed == null) {
              return;
            }
            body.maxRetries = parsed;
          }
          if (opts.retryBackoffMs != null) {
            const parsed = parseInteger(
              "--retry-backoff-ms",
              opts.retryBackoffMs,
            );
            if (parsed == null) {
              return;
            }
            body.retryBackoffMs = parsed;
          }
          if (opts.timeoutMs != null) {
            const parsed = parseInteger("--timeout-ms", opts.timeoutMs);
            if (parsed == null) {
              return;
            }
            body.timeoutMs = parsed;
          }
          if (opts.clearTimeout) {
            body.timeoutMs = null;
          }
          if (opts.profile != null) {
            body.inferenceProfile = opts.profile;
          }
          if (opts.clearProfile) {
            body.inferenceProfile = null;
          }

          if (Object.keys(body).length === 0) {
            fail(
              "At least one update flag is required. Run 'assistant schedules update --help' for the available flags.",
            );
            return;
          }

          const result = await cliIpcCall<ListSchedulesResponse>(
            "updateSchedule",
            { pathParams: { id: scheduleId }, body },
          );

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

          const response = result.result ?? { schedules: [] };
          if (opts.json) {
            writeOutput(cmd, response);
            return;
          }

          log.info(`Updated schedule: ${scheduleId}`);
        },
      );

      subcommand(schedules, "enable").action(
        async (id: string, opts: { json?: boolean }, cmd: Command) => {
          await toggleScheduleEnabled(id, true, opts, cmd);
        },
      );

      subcommand(schedules, "disable").action(
        async (id: string, opts: { json?: boolean }, cmd: Command) => {
          await toggleScheduleEnabled(id, false, opts, cmd);
        },
      );

      subcommand(schedules, "cancel").action(
        async (id: string, opts: { json?: boolean }, cmd: Command) => {
          const scheduleId = id.trim();
          const result = await cliIpcCall<ListSchedulesResponse>(
            "cancelSchedule",
            { pathParams: { id: scheduleId } },
          );

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

          const response = result.result ?? { schedules: [] };
          if (opts.json) {
            writeOutput(cmd, response);
            return;
          }

          log.info(`Cancelled schedule: ${scheduleId}`);
        },
      );

      subcommand(schedules, "delete").action(
        async (
          id: string,
          opts: { force?: boolean; json?: boolean },
          cmd: Command,
        ) => {
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

          if (!opts.force) {
            const decision = await confirmPrompt({
              question: `Delete schedule "${scheduleId}"? [y/N] `,
              isTTY: Boolean(process.stdin.isTTY),
              refuseNonInteractiveMessage: `Refusing to delete schedule "${scheduleId}" non-interactively. Pass --force to confirm.`,
            });
            if (decision === "non-interactive") {
              process.exitCode = 1;
              return;
            }
            if (decision === "denied") {
              log.info("Delete cancelled.");
              return;
            }
          }

          const result = await cliIpcCall<ListSchedulesResponse>(
            "deleteSchedule",
            { pathParams: { id: scheduleId } },
          );

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

          const response = result.result ?? { schedules: [] };
          if (opts.json) {
            writeOutput(cmd, response);
            return;
          }

          log.info(`Deleted schedule: ${scheduleId}`);
        },
      );

      subcommand(schedules, "execute").action(
        async (id: string, opts: { json?: boolean }, cmd: Command) => {
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

          if (!result.ok) {
            return exitFromIpcResult(result, cmd);
          }

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
        },
      );

      registerSchedulesWorkerCommand(schedules);
    },
  });
}

async function toggleScheduleEnabled(
  id: string,
  enabled: boolean,
  opts: { json?: boolean },
  cmd: Command,
): Promise<void> {
  const scheduleId = id.trim();
  const result = await cliIpcCall<ListSchedulesResponse>("toggleSchedule", {
    pathParams: { id: scheduleId },
    body: { enabled },
  });

  if (!result.ok) {
    return exitFromIpcResult(result, cmd);
  }

  const response = result.result ?? { schedules: [] };
  if (opts.json) {
    writeOutput(cmd, response);
    return;
  }

  log.info(`${enabled ? "Enabled" : "Disabled"} schedule: ${scheduleId}`);
}

function describeSchedule(schedule: ScheduleRecord): string {
  if (schedule.isOneShot) {
    return "one-shot";
  }
  const expression = schedule.cadenceDescription ?? schedule.expression ?? "—";
  return schedule.timezone
    ? `${expression} (${schedule.timezone})`
    : expression;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "—";
  }
  return new Date(value).toISOString();
}

function formatNullableTimestamp(value: number | null): string {
  return value == null ? "—" : formatTimestamp(value);
}

/** Run costs render "—" when absent or zero; positive values use the shared USD formatter. */
function formatRunCost(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return "—";
  }
  return formatCostUsd(value);
}

function formatDuration(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }

  // Keep one decimal of precision only in the sub-minute range, where it's
  // meaningful; coarser units round to whole seconds. Working in tenths of a
  // second lets the tier boundary (e.g. 59.97s) round up cleanly to "1m".
  const tenths = Math.round(value / 100);
  if (tenths < 600) {
    const seconds = tenths / 10;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
