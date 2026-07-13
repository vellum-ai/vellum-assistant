/** Declarative help for the `assistant schedules` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const schedulesHelp: CliCommandHelp = {
  name: "schedules",
  description: "Manage scheduled jobs",
  helpText: `
Schedules are recurring or one-shot jobs run by the assistant.

This namespace exposes full CRUD against the assistant's schedule store:
create, list, get, update, enable/disable, cancel, delete, plus run history
and manual one-time execution. One documented exception: 'create' is limited
to 'execute' mode — notify/script/wake schedules are created via the
in-assistant schedule_create tool, but can be inspected and updated here.

The 'worker' subgroup manages the schedule worker process, which runs
scheduled jobs in a separate OS process.

Examples:
  $ assistant schedules list
  $ assistant schedules get <schedule-id>
  $ assistant schedules update <schedule-id> --expression '0 9 * * *'
  $ assistant schedules runs <schedule-id> --limit 25 --json
  $ assistant schedules execute <schedule-id>
  $ assistant schedules worker status`,
  subcommands: [
    {
      name: "list",
      description: "List assistant schedules",
      options: [
        {
          flags: "--all",
          description: "Include deferred schedules that are hidden by default",
        },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Options:
  --all    Include deferred schedules that are normally hidden.
  --json   Output the raw schedule list as compact JSON.

Examples:
  $ assistant schedules list
  $ assistant schedules list --all
  $ assistant schedules list --json`,
    },
    {
      name: "get",
      args: "<id>",
      description: "Show full details for a single schedule",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
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
  Aliased as 'inspect'.

Examples:
  $ assistant schedules get 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules inspect 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules get 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
    },
    {
      name: "runs",
      args: "<id>",
      description: "List recent runs for a schedule",
      options: [
        {
          flags: "--limit <count>",
          description: "Max runs to return (default 10, max 100)",
        },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Options:
  --limit <count>   Max runs to return. The assistant clamps values to 1-100.
  --json            Output the raw run list as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list' to find it.

Examples:
  $ assistant schedules runs 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules runs 9f2c4f3a-3f1a-41e4-88e7-abc123 --limit 25
  $ assistant schedules runs 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
    },
    {
      name: "create",
      args: "<name>",
      description: "Create a new recurring schedule",
      options: [
        {
          flags: "-e, --expression <expr>",
          description: "Cron or RRULE expression that schedules the fire times",
          required: true,
        },
        {
          flags: "-d, --description <text>",
          description:
            "Authored description explaining what the schedule is for",
          required: true,
        },
        {
          flags: "-m, --message <text>",
          description:
            "Message body sent to the assistant on each fire (required for execute mode)",
        },
        {
          flags: "--mode <mode>",
          description:
            "Schedule mode: 'execute' (default), 'script', or 'workflow'",
        },
        {
          flags: "--script <command>",
          description:
            "Shell command to run on each fire (required for --mode script)",
        },
        {
          flags: "--timeout-ms <ms>",
          description:
            "Script execution timeout override in ms (--mode script)",
        },
        {
          flags: "-t, --timezone <tz>",
          description:
            "IANA timezone for the expression (e.g. America/New_York)",
        },
        {
          flags: "--profile <name>",
          description:
            "Inference profile (llm.profiles key) the schedule's runs use; defaults to the mainAgent model selection when omitted",
        },
        {
          flags: "--no-enabled",
          description: "Create the schedule in a disabled state",
        },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Options:
  -e, --expression <expr>   Cron (e.g. '*/30 * * * *') or RRULE expression.
  -d, --description <text>  Authored description explaining what the schedule is for.
  -m, --message <text>      Message body sent on each fire (execute mode).
  --mode <mode>             execute (default), script, or workflow.
  --script <command>        Shell command for --mode script.
  --timeout-ms <ms>         Script timeout override in ms (--mode script).
  -t, --timezone <tz>       IANA timezone applied to the expression.
  --profile <name>          Inference profile (llm.profiles key) the schedule's
                            runs use. When omitted, runs use the default —
                            the mainAgent call site's model selection.
  --no-enabled              Create the schedule disabled. Defaults to enabled.
  --json                    Output the updated schedule list as compact JSON.

Arguments:
  <name>   Display name for the schedule.

Behavior:
  Defaults to 'execute' mode (requires --message). Pass --mode script with
  --script to run a shell command on each fire with no LLM call; the script's
  env includes $VELLUM_WORKSPACE_DIR and $__SCHEDULE_ID (this schedule's id).
  notify/wake schedules remain reachable only through the schedule_create tool.

Examples:
  $ assistant schedules create "GitHub watcher" \\
      --mode script \\
      --script 'cd "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID" && bun poll.ts' \\
      --expression '*/15 * * * *' \\
      --description 'Polls GitHub notifications' --json
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
    },
    {
      name: "update",
      args: "<id>",
      description: "Update fields on an existing schedule",
      options: [
        { flags: "--name <text>", description: "New display name" },
        {
          flags: "-d, --description <text>",
          description:
            "New authored description explaining what the schedule is for",
        },
        {
          flags: "-e, --expression <expr>",
          description: "New cron or RRULE expression for the fire times",
        },
        {
          flags: "-t, --timezone <tz>",
          description:
            "IANA timezone for the expression (e.g. America/New_York)",
        },
        {
          flags: "-m, --message <text>",
          description: "New message body sent to the assistant on each fire",
        },
        {
          flags: "--script <command>",
          description: "Shell command for script-mode schedules",
        },
        {
          flags: "--mode <mode>",
          description:
            "One of: notify, execute, script, wake (wake only when the schedule already has a wake conversation target)",
        },
        {
          flags: "--routing-intent <intent>",
          description: "One of: single_channel, multi_channel, all_channels",
        },
        {
          flags: "--quiet",
          description: "Suppress notifications for this schedule",
        },
        {
          flags: "--no-quiet",
          description: "Re-enable notifications for this schedule",
        },
        {
          flags: "--reuse-conversation",
          description: "Reuse one conversation across recurring fires",
        },
        {
          flags: "--no-reuse-conversation",
          description: "Start a fresh conversation on each fire",
        },
        {
          flags: "--max-retries <count>",
          description: "Maximum retry attempts (integer)",
        },
        {
          flags: "--retry-backoff-ms <ms>",
          description: "Retry backoff in milliseconds (integer)",
        },
        {
          flags: "--timeout-ms <ms>",
          description:
            "Script-mode execution timeout in milliseconds (integer)",
        },
        {
          flags: "--clear-timeout",
          description:
            "Clear the script timeout override and use the assistant default",
        },
        {
          flags: "--profile <name>",
          description:
            "Inference profile (llm.profiles key) the schedule's runs use; the default when unset is the mainAgent model selection",
        },
        {
          flags: "--clear-profile",
          description:
            "Clear the inference profile and revert to the default mainAgent model selection",
        },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
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
    },
    {
      name: "enable",
      args: "<id>",
      description: "Enable a schedule",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
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
    },
    {
      name: "disable",
      args: "<id>",
      description: "Disable a schedule",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
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
    },
    {
      name: "cancel",
      args: "<id>",
      description: "Cancel a pending one-shot schedule",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
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
    },
    {
      name: "delete",
      args: "<id>",
      description: "Permanently delete a schedule and its run history",
      options: [
        { flags: "--force", description: "Skip the confirmation prompt" },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
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
    },
    {
      name: "execute",
      args: "<id>",
      description: "Execute a schedule one time immediately",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Options:
  --json   Output the run-now result as compact JSON.

Arguments:
  <id>   Schedule ID (UUID) — run 'assistant schedules list' to find it.

Examples:
  $ assistant schedules execute 9f2c4f3a-3f1a-41e4-88e7-abc123
  $ assistant schedules execute 9f2c4f3a-3f1a-41e4-88e7-abc123 --json`,
    },
    {
      name: "worker",
      description: "Manage the schedule worker process (start/stop/status)",
      helpText: `
The schedule worker runs scheduled jobs in a separate OS process so expensive
scheduled work executes off the assistant's main event loop. The assistant
spawns it as a child process at startup, so it shows up in \`assistant ps\`.

\`start\` and \`stop\` manage that process on demand (respawn or SIGTERM); the
worker is spun up by default at startup.

Examples:
  $ assistant schedules worker start
  $ assistant schedules worker status
  $ assistant schedules worker stop`,
      subcommands: [
        {
          name: "start",
          description: "Spawn the schedule worker process if it is not running",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
        {
          name: "stop",
          description: "SIGTERM the schedule worker process",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
        {
          name: "status",
          description: "Report the schedule worker process liveness",
          options: [
            {
              flags: "--json",
              description: "Emit raw JSON instead of a formatted summary",
            },
          ],
        },
      ],
    },
  ],
};
