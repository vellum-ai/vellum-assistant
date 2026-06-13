import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { confirmPrompt } from "../lib/confirm-prompt.js";
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

This namespace exposes full CRUD against the assistant's schedule store:
create, list, get, update, enable/disable, cancel, delete, plus run history
and manual one-time execution. One documented exception: 'create' is limited
to 'execute' mode — notify/script/wake schedules are created via the
in-assistant schedule_create tool, but can be inspected and updated here.

Examples:
  $ assistant schedules list
  $ assistant schedules get <schedule-id>
  $ assistant schedules update <schedule-id> --expression '0 9 * * *'
  $ assistant schedules runs <schedule-id> --limit 25 --json
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
        .command("get <id>")
        .description("Show full details for a single schedule")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --json   Output the raw schedule object as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list --all' to find it.

Behavior:
  Prints every stored field of the schedule: name, description, mode,
  expression/syntax, timezone, enabled state, status, next/last run times,
  message or script body, inference profile (shown as 'default (mainAgent)'
  when none is pinned), routing intent, and retry policy. Works for
  deferred schedules that 'assistant schedules list' hides by default.

Examples:
  $ assistant schedules get 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules get 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        )
        .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
          const scheduleId = id.trim();
          const result = await cliIpcCall<GetScheduleResponse>("getSchedule", {
            pathParams: { id: scheduleId },
          });

          if (!result.ok) return exitFromIpcResult(result, cmd);

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
        .command("create <name>")
        .description("Create a new recurring schedule")
        .requiredOption(
          "-e, --expression <expr>",
          "Cron or RRULE expression that schedules the fire times",
        )
        .requiredOption(
          "-d, --description <text>",
          "Authored description explaining what the schedule is for",
        )
        .requiredOption(
          "-m, --message <text>",
          "Message body sent to the assistant on each fire",
        )
        .option(
          "-t, --timezone <tz>",
          "IANA timezone for the expression (e.g. America/New_York)",
        )
        .option(
          "--profile <name>",
          "Inference profile (llm.profiles key) the schedule's runs use; defaults to the mainAgent model selection when omitted",
        )
        .option("--no-enabled", "Create the schedule in a disabled state")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  -e, --expression <expr>   Cron (e.g. '*/30 * * * *') or RRULE expression.
  -d, --description <text>  Authored description explaining what the schedule is for.
  -m, --message <text>      Message body sent on each fire.
  -t, --timezone <tz>       IANA timezone applied to the expression.
  --profile <name>          Inference profile (llm.profiles key) the schedule's
                            runs use. When omitted, runs use the default —
                            the mainAgent call site's model selection.
  --no-enabled              Create the schedule disabled. Defaults to enabled.
  --json                    Output the updated schedule list as compact JSON.

Arguments:
  <name>   Display name for the schedule.

Behavior:
  Creates a recurring schedule in 'execute' mode. The IPC endpoint is
  currently locked to execute mode; notify/script/wake schedules remain
  reachable only through the in-assistant schedule_create LLM tool.

Examples:
  $ assistant schedules create "Heartbeat" \\
      --expression '*/30 * * * *' \\
      --description 'Checks service heartbeat every 30 minutes' \\
      --message 'run heartbeat'
  $ assistant schedules create "Morning summary" \\
      --expression '0 9 * * MON-FRI' \\
      --description 'Summarizes weekday activity' \\
      --timezone America/New_York \\
      --message 'write the morning summary'
  $ assistant schedules create "Drafted" \\
      --expression '0 0 * * *' \\
      --description 'Placeholder daily schedule' \\
      --message 'placeholder' \\
      --no-enabled --json`,
        )
        .action(
          async (
            name: string,
            opts: {
              expression: string;
              description: string;
              message: string;
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

            const body: Record<string, unknown> = {
              name: scheduleName,
              expression: opts.expression,
              description,
              message: opts.message,
              enabled: opts.enabled,
            };
            if (opts.timezone != null) body.timezone = opts.timezone;
            if (opts.profile != null) body.inferenceProfile = opts.profile;

            const result = await cliIpcCall<ListSchedulesResponse>(
              "createSchedule",
              { body },
            );

            if (!result.ok) return exitFromIpcResult(result, cmd);

            const response = result.result ?? { schedules: [] };
            if (opts.json) {
              writeOutput(cmd, response);
              return;
            }

            log.info(`Created schedule: ${scheduleName}`);
          },
        );

      schedules
        .command("update <id>")
        .description("Update fields on an existing schedule")
        .option("--name <text>", "New display name")
        .option(
          "-d, --description <text>",
          "New authored description explaining what the schedule is for",
        )
        .option(
          "-e, --expression <expr>",
          "New cron or RRULE expression for the fire times",
        )
        .option(
          "-t, --timezone <tz>",
          "IANA timezone for the expression (e.g. America/New_York)",
        )
        .option(
          "-m, --message <text>",
          "New message body sent to the assistant on each fire",
        )
        .option("--script <command>", "Shell command for script-mode schedules")
        .option(
          "--mode <mode>",
          "One of: notify, execute, script, wake (wake only when the schedule already has a wake conversation target)",
        )
        .option(
          "--routing-intent <intent>",
          "One of: single_channel, multi_channel, all_channels",
        )
        .option("--quiet", "Suppress notifications for this schedule")
        .option("--no-quiet", "Re-enable notifications for this schedule")
        .option(
          "--reuse-conversation",
          "Reuse one conversation across recurring fires",
        )
        .option(
          "--no-reuse-conversation",
          "Start a fresh conversation on each fire",
        )
        .option("--max-retries <count>", "Maximum retry attempts (integer)")
        .option(
          "--retry-backoff-ms <ms>",
          "Retry backoff in milliseconds (integer)",
        )
        .option(
          "--timeout-ms <ms>",
          "Script-mode execution timeout in milliseconds (integer)",
        )
        .option(
          "--clear-timeout",
          "Clear the script timeout override and use the assistant default",
        )
        .option(
          "--profile <name>",
          "Inference profile (llm.profiles key) the schedule's runs use; the default when unset is the mainAgent model selection",
        )
        .option(
          "--clear-profile",
          "Clear the inference profile and revert to the default mainAgent model selection",
        )
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --name <text>             New display name.
  -d, --description <text>  New authored description (must be non-empty).
  -e, --expression <expr>   Cron (e.g. '*/30 * * * *') or RRULE expression.
  -t, --timezone <tz>       IANA timezone applied to the expression.
  -m, --message <text>      New message body sent on each fire.
  --script <command>        Shell command for script-mode schedules.
  --mode <mode>             notify, execute, script, or wake.
  --routing-intent <intent> single_channel, multi_channel, or all_channels.
  --quiet / --no-quiet      Toggle notification suppression.
  --reuse-conversation / --no-reuse-conversation
                            Toggle conversation reuse across recurring fires.
  --max-retries <count>     Maximum retry attempts.
  --retry-backoff-ms <ms>   Retry backoff in milliseconds.
  --timeout-ms <ms>         Script-mode execution timeout in milliseconds.
  --clear-timeout           Remove the timeout override (mutually exclusive
                            with --timeout-ms).
  --profile <name>          Inference profile (llm.profiles key) the schedule's
                            runs use. When no profile is set, runs use the
                            default — the mainAgent call site's model selection.
  --clear-profile           Remove the inference profile and revert to the
                            default mainAgent model selection (mutually
                            exclusive with --profile).
  --json                    Output the updated schedule list as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list --all' to find it.

Behavior:
  Partially updates the schedule: only fields for flags you pass are changed,
  everything else is preserved. At least one update flag is required. To
  enable or disable a schedule, use 'assistant schedules enable <id>' or
  'assistant schedules disable <id>' instead.

Examples:
  $ assistant schedules update 9f2c4f3a-3f1a-41e4-88e7-abc123 \\
      --expression '0 9 * * MON-FRI' --timezone America/New_York
  $ assistant schedules update 9f2c4f3a-3f1a-41e4-88e7-abc123 \\
      --name "Morning summary" --message 'write the morning summary'
  $ assistant schedules update 9f2c4f3a-3f1a-41e4-88e7-abc123 \\
      --max-retries 5 --retry-backoff-ms 30000 --json`,
        )
        .action(
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

            const parseInteger = (
              flag: string,
              value: string,
            ): number | null => {
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
              if (!existing.ok) return exitFromIpcResult(existing, cmd);
              if (!existing.result?.schedule.wakeConversationId) {
                fail(
                  "--mode wake requires the schedule to already have a wake conversation target; this CLI cannot set one. Create wake schedules with the schedule tool instead.",
                );
                return;
              }
            }

            const body: Record<string, unknown> = {};
            if (opts.name != null) body.name = opts.name;
            if (opts.description != null) body.description = opts.description;
            if (opts.expression != null) body.expression = opts.expression;
            if (opts.timezone != null) body.timezone = opts.timezone;
            if (opts.message != null) body.message = opts.message;
            if (opts.script != null) body.script = opts.script;
            if (opts.mode != null) body.mode = opts.mode;
            if (opts.routingIntent != null) {
              body.routingIntent = opts.routingIntent;
            }
            if (opts.quiet != null) body.quiet = opts.quiet;
            if (opts.reuseConversation != null) {
              body.reuseConversation = opts.reuseConversation;
            }
            if (opts.maxRetries != null) {
              const parsed = parseInteger("--max-retries", opts.maxRetries);
              if (parsed == null) return;
              body.maxRetries = parsed;
            }
            if (opts.retryBackoffMs != null) {
              const parsed = parseInteger(
                "--retry-backoff-ms",
                opts.retryBackoffMs,
              );
              if (parsed == null) return;
              body.retryBackoffMs = parsed;
            }
            if (opts.timeoutMs != null) {
              const parsed = parseInteger("--timeout-ms", opts.timeoutMs);
              if (parsed == null) return;
              body.timeoutMs = parsed;
            }
            if (opts.clearTimeout) body.timeoutMs = null;
            if (opts.profile != null) body.inferenceProfile = opts.profile;
            if (opts.clearProfile) body.inferenceProfile = null;

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

            if (!result.ok) return exitFromIpcResult(result, cmd);

            const response = result.result ?? { schedules: [] };
            if (opts.json) {
              writeOutput(cmd, response);
              return;
            }

            log.info(`Updated schedule: ${scheduleId}`);
          },
        );

      schedules
        .command("enable <id>")
        .description("Enable a schedule")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --json   Output the updated schedule list as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list --all' to find it.

Behavior:
  Enables the schedule so it can run on future matching times. This does not
  execute the schedule immediately; use 'assistant schedules execute <id>' for
  manual run-now behavior.

Examples:
  $ assistant schedules enable 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules enable 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        )
        .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
          await toggleScheduleEnabled(id, true, opts, cmd);
        });

      schedules
        .command("disable <id>")
        .description("Disable a schedule")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --json   Output the updated schedule list as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list --all' to find it.

Behavior:
  Disables the schedule so future scheduled fires are skipped until it is
  enabled again. Existing run history is preserved.

Examples:
  $ assistant schedules disable 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules disable 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
        )
        .action(async (id: string, opts: { json?: boolean }, cmd: Command) => {
          await toggleScheduleEnabled(id, false, opts, cmd);
        });

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
  use 'assistant schedules disable <id>' to pause recurring schedules.

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
        .command("delete <id>")
        .description("Permanently delete a schedule and its run history")
        .option("--force", "Skip the confirmation prompt")
        .option("--json", "Machine-readable compact JSON output")
        .addHelpText(
          "after",
          `
Options:
  --force  Skip the destructive y/N confirmation prompt. Required when stdin
           is not a TTY (e.g. in scripts and CI).
  --json   Output the updated schedule list as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list --all' to find it.

Behavior:
  Permanently removes the schedule and its run history. This cannot be undone.
  To temporarily pause a recurring schedule, use
  'assistant schedules disable <id>' instead.

Examples:
  $ assistant schedules delete 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules delete 9f2c4f3a-3f1a-41e4-88e7-abc123 --force
  $ assistant schedules delete 9f2c4f3a-3f1a-41e4-88e7-abc123 --force --json`,
        )
        .action(
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

            if (!result.ok) return exitFromIpcResult(result, cmd);

            const response = result.result ?? { schedules: [] };
            if (opts.json) {
              writeOutput(cmd, response);
              return;
            }

            log.info(`Deleted schedule: ${scheduleId}`);
          },
        );

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

  if (!result.ok) return exitFromIpcResult(result, cmd);

  const response = result.result ?? { schedules: [] };
  if (opts.json) {
    writeOutput(cmd, response);
    return;
  }

  log.info(`${enabled ? "Enabled" : "Disabled"} schedule: ${scheduleId}`);
}

function describeSchedule(schedule: ScheduleRecord): string {
  if (schedule.isOneShot) return "one-shot";
  const expression = schedule.cadenceDescription ?? schedule.expression ?? "—";
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
