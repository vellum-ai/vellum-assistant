/** Declarative help for the `assistant usage` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const usageHelp: CliCommandHelp = {
  name: "usage",
  description: "Query LLM token usage and cost data",
  helpText: `
Queries LLM usage event data via the daemon to display token consumption
and cost data. Requires the assistant to be running.

Time range can be specified with --range presets (today, week, month, all)
or explicit --from / --to epoch-millisecond timestamps.

Examples:
  $ assistant usage totals
  $ assistant usage daily --range week
  $ assistant usage breakdown --group-by provider
  $ assistant usage totals --range all --json`,
  subcommands: [
    {
      name: "totals",
      isDefault: true,
      description: "Aggregate totals for a time range",
      options: [
        {
          flags: "-r, --range <preset>",
          description: "Time range preset: today, week, month, all",
          defaultValue: "today",
        },
        {
          flags: "--from <epoch_ms>",
          description: "Start of range (epoch ms)",
        },
        { flags: "--to <epoch_ms>", description: "End of range (epoch ms)" },
        {
          flags: "--schedule <id>",
          description:
            "Filter to a schedule id — run 'assistant schedules list' to find it; attributes usage by that schedule's cron run windows",
        },
        { flags: "--json", description: "Output raw JSON" },
      ],
      helpText: `
Shows aggregate token counts and estimated cost across all LLM calls
within the time range.

Columns: estimated cost, LLM call count, input/output tokens, cache
creation/read tokens, unpriced event count (if any).

Pass --schedule <id> to restrict totals to a single schedule's cron run
windows. Find schedule ids with 'assistant schedules list'.

Examples:
  $ assistant usage totals
  $ assistant usage totals --range all
  $ assistant usage totals --schedule sched-abc123
  $ assistant usage totals --from 1709856000000 --to 1709942400000`,
    },
    {
      name: "daily",
      description: "Per-day token and cost breakdown",
      options: [
        {
          flags: "-r, --range <preset>",
          description: "Time range preset: today, week, month, all",
          defaultValue: "today",
        },
        {
          flags: "--from <epoch_ms>",
          description: "Start of range (epoch ms)",
        },
        { flags: "--to <epoch_ms>", description: "End of range (epoch ms)" },
        {
          flags: "--schedule <id>",
          description:
            "Filter to a schedule id — run 'assistant schedules list' to find it; attributes usage by that schedule's cron run windows",
        },
        { flags: "--json", description: "Output raw JSON" },
      ],
      helpText: `
Shows one row per day (UTC) with input tokens, output tokens, estimated
cost, and LLM call count.

Pass --schedule <id> to restrict the breakdown to a single schedule's cron
run windows. Find schedule ids with 'assistant schedules list'.

Examples:
  $ assistant usage daily
  $ assistant usage daily --range week
  $ assistant usage daily --schedule sched-abc123
  $ assistant usage daily --range month --json`,
    },
    {
      name: "breakdown",
      description:
        "Grouped breakdown by task, profile, provider, model, or conversation",
      options: [
        {
          flags: "-r, --range <preset>",
          description: "Time range preset: today, week, month, all",
          defaultValue: "today",
        },
        {
          flags: "--from <epoch_ms>",
          description: "Start of range (epoch ms)",
        },
        { flags: "--to <epoch_ms>", description: "End of range (epoch ms)" },
        {
          flags: "--schedule <id>",
          description:
            "Filter to a schedule id — run 'assistant schedules list' to find it; attributes usage by that schedule's cron run windows",
        },
        { flags: "--json", description: "Output raw JSON" },
        {
          flags: "-g, --group-by <dimension>",
          description:
            "Grouping dimension: call_site, inference_profile, provider, model, conversation, actor",
          defaultValue: "model",
        },
      ],
      helpText: `
Grouping dimensions:
  call_site          Groups by user-facing task (Main Agent, Memory Extraction,
                     Conversation Title, etc.)
  inference_profile  Groups by inference profile; unset historical rows are
                     shown as Default / Unset
  provider           Groups by LLM provider (anthropic, openai, etc.)
  model              Groups by model name (claude-sonnet-4-20250514, etc.)
  conversation       Groups by conversation ID
  actor              Legacy/internal subsystem grouping (main_agent, etc.)

Shows one row per group with input/output tokens, estimated cost, and
call count. Rows are sorted by cost descending.

Pass --schedule <id> to restrict the breakdown to a single schedule's cron
run windows. Find schedule ids with 'assistant schedules list'.

Examples:
  $ assistant usage breakdown
  $ assistant usage breakdown --group-by call_site
  $ assistant usage breakdown --group-by inference_profile
  $ assistant usage breakdown --group-by provider
  $ assistant usage breakdown --schedule sched-abc123
  $ assistant usage breakdown --group-by actor --range week`,
    },
  ],
};
