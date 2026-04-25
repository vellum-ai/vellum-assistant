import type { Command } from "commander";

import { getDb } from "../../memory/db.js";
import {
  getUsageDayBuckets,
  getUsageGroupBreakdown,
  getUsageTotals,
  type UsageDayBucket,
  type UsageGroupBreakdown,
  type UsageTotals,
} from "../../memory/llm-usage-store.js";
import { log } from "../logger.js";

// ── Formatting helpers ───────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function pad(s: string, w: number, align: "left" | "right" = "left"): string {
  const padding = " ".repeat(Math.max(0, w - s.length));
  return align === "right" ? padding + s : s + padding;
}

// ── Time range resolution ────────────────────────────────────────

type RangePreset = "today" | "week" | "month" | "all";

function resolveTimeRange(preset: RangePreset): { from: number; to: number } {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  switch (preset) {
    case "today":
      return { from: startOfToday.getTime(), to: now };
    case "week": {
      const weekAgo = new Date(startOfToday);
      weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
      return { from: weekAgo.getTime(), to: now };
    }
    case "month": {
      const monthAgo = new Date(startOfToday);
      monthAgo.setUTCDate(monthAgo.getUTCDate() - 30);
      return { from: monthAgo.getTime(), to: now };
    }
    case "all":
      return { from: 0, to: now };
  }
}

// ── Table printers ───────────────────────────────────────────────

function printTotalsTable(totals: UsageTotals): void {
  log.info("");
  log.info("  Usage Totals");
  log.info("  ────────────────────────────────────");
  log.info(`  Estimated Cost     ${formatCost(totals.totalEstimatedCostUsd)}`);
  log.info(`  LLM Calls          ${totals.eventCount}`);
  log.info(`  Input Tokens       ${formatTokens(totals.totalInputTokens)}`);
  log.info(`  Output Tokens      ${formatTokens(totals.totalOutputTokens)}`);
  log.info(
    `  Cache Created      ${formatTokens(totals.totalCacheCreationTokens)}`,
  );
  log.info(`  Cache Read         ${formatTokens(totals.totalCacheReadTokens)}`);
  if (totals.unpricedEventCount > 0) {
    log.info(`  Unpriced Events    ${totals.unpricedEventCount}`);
  }
  log.info("");
}

function printDailyTable(buckets: UsageDayBucket[]): void {
  if (buckets.length === 0) {
    log.info("\n  No usage data for the selected time range.\n");
    return;
  }

  const dateW = Math.max("DATE".length, ...buckets.map((b) => b.date.length));
  const inputW = Math.max(
    "INPUT".length,
    ...buckets.map((b) => formatTokens(b.totalInputTokens).length),
  );
  const outputW = Math.max(
    "OUTPUT".length,
    ...buckets.map((b) => formatTokens(b.totalOutputTokens).length),
  );
  const costW = Math.max(
    "COST".length,
    ...buckets.map((b) => formatCost(b.totalEstimatedCostUsd).length),
  );
  const callsW = Math.max(
    "CALLS".length,
    ...buckets.map((b) => String(b.eventCount).length),
  );

  log.info("");
  log.info(
    `  ${pad("DATE", dateW)}  ${pad("INPUT", inputW, "right")}  ${pad("OUTPUT", outputW, "right")}  ${pad("COST", costW, "right")}  ${pad("CALLS", callsW, "right")}`,
  );
  log.info(
    `  ${"-".repeat(dateW)}  ${"-".repeat(inputW)}  ${"-".repeat(outputW)}  ${"-".repeat(costW)}  ${"-".repeat(callsW)}`,
  );

  for (const b of buckets) {
    log.info(
      `  ${pad(b.date, dateW)}  ${pad(formatTokens(b.totalInputTokens), inputW, "right")}  ${pad(formatTokens(b.totalOutputTokens), outputW, "right")}  ${pad(formatCost(b.totalEstimatedCostUsd), costW, "right")}  ${pad(String(b.eventCount), callsW, "right")}`,
    );
  }
  log.info("");
}

function printBreakdownTable(
  entries: UsageGroupBreakdown[],
  groupBy: string,
): void {
  if (entries.length === 0) {
    log.info("\n  No usage data for the selected time range.\n");
    return;
  }

  const groupLabel = groupBy.toUpperCase();
  const groupW = Math.max(
    groupLabel.length,
    ...entries.map((e) => e.group.length),
  );
  const inputW = Math.max(
    "INPUT".length,
    ...entries.map((e) => formatTokens(e.totalInputTokens).length),
  );
  const outputW = Math.max(
    "OUTPUT".length,
    ...entries.map((e) => formatTokens(e.totalOutputTokens).length),
  );
  const costW = Math.max(
    "COST".length,
    ...entries.map((e) => formatCost(e.totalEstimatedCostUsd).length),
  );
  const callsW = Math.max(
    "CALLS".length,
    ...entries.map((e) => String(e.eventCount).length),
  );

  log.info("");
  log.info(
    `  ${pad(groupLabel, groupW)}  ${pad("INPUT", inputW, "right")}  ${pad("OUTPUT", outputW, "right")}  ${pad("COST", costW, "right")}  ${pad("CALLS", callsW, "right")}`,
  );
  log.info(
    `  ${"-".repeat(groupW)}  ${"-".repeat(inputW)}  ${"-".repeat(outputW)}  ${"-".repeat(costW)}  ${"-".repeat(callsW)}`,
  );

  for (const e of entries) {
    log.info(
      `  ${pad(e.group, groupW)}  ${pad(formatTokens(e.totalInputTokens), inputW, "right")}  ${pad(formatTokens(e.totalOutputTokens), outputW, "right")}  ${pad(formatCost(e.totalEstimatedCostUsd), costW, "right")}  ${pad(String(e.eventCount), callsW, "right")}`,
    );
  }
  log.info("");
}

// ── Command registration ─────────────────────────────────────────

export function registerUsageCommand(program: Command): void {
  const usage = program
    .command("usage")
    .description("Query LLM token usage and cost data");

  usage.addHelpText(
    "after",
    `
Reads from the local LLM usage event ledger (llm_usage_events table) to
display token consumption and cost data. Operates on the local SQLite
database directly — does not require the assistant to be running.

Time range can be specified with --range presets (today, week, month, all)
or explicit --from / --to epoch-millisecond timestamps.

Examples:
  $ assistant usage totals
  $ assistant usage daily --range week
  $ assistant usage breakdown --group-by provider
  $ assistant usage totals --range all --json`,
  );

  const rangeOption = [
    "-r, --range <preset>",
    "Time range preset: today, week, month, all",
    "today",
  ] as const;
  const fromOption = [
    "--from <epoch_ms>",
    "Start of range (epoch ms)",
  ] as const;
  const toOption = ["--to <epoch_ms>", "End of range (epoch ms)"] as const;
  const jsonOption = ["--json", "Output raw JSON"] as const;

  usage
    .command("totals", { isDefault: true })
    .description("Aggregate totals for a time range")
    .option(...rangeOption)
    .option(...fromOption)
    .option(...toOption)
    .option(...jsonOption)
    .addHelpText(
      "after",
      `
Shows aggregate token counts and estimated cost across all LLM calls
within the time range.

Columns: estimated cost, LLM call count, input/output tokens, cache
creation/read tokens, unpriced event count (if any).

Examples:
  $ assistant usage totals
  $ assistant usage totals --range all
  $ assistant usage totals --from 1709856000000 --to 1709942400000`,
    )
    .action(
      (opts: { range: string; from?: string; to?: string; json?: boolean }) => {
        getDb();
        const { from, to } = resolveRange(opts);
        const totals = getUsageTotals({ from, to });
        if (opts.json) {
          log.info(JSON.stringify(totals, null, 2));
        } else {
          printTotalsTable(totals);
        }
      },
    );

  usage
    .command("daily")
    .description("Per-day token and cost breakdown")
    .option(...rangeOption)
    .option(...fromOption)
    .option(...toOption)
    .option(...jsonOption)
    .addHelpText(
      "after",
      `
Shows one row per day (UTC) with input tokens, output tokens, estimated
cost, and LLM call count.

Examples:
  $ assistant usage daily
  $ assistant usage daily --range week
  $ assistant usage daily --range month --json`,
    )
    .action(
      (opts: { range: string; from?: string; to?: string; json?: boolean }) => {
        getDb();
        const { from, to } = resolveRange(opts);
        const buckets = getUsageDayBuckets({ from, to });
        if (opts.json) {
          log.info(JSON.stringify({ buckets }, null, 2));
        } else {
          printDailyTable(buckets);
        }
      },
    );

  usage
    .command("breakdown")
    .description("Grouped breakdown by actor, provider, model, or conversation")
    .option(...rangeOption)
    .option(...fromOption)
    .option(...toOption)
    .option(...jsonOption)
    .option(
      "-g, --group-by <dimension>",
      "Grouping dimension: actor, provider, model, conversation",
      "model",
    )
    .addHelpText(
      "after",
      `
Grouping dimensions:
  actor          Groups by the subsystem that made the call (main_agent,
                 title_generator, etc.)
  provider       Groups by LLM provider (anthropic, openai, etc.)
  model          Groups by model name (claude-sonnet-4-20250514, etc.)
  conversation   Groups by conversation ID

Shows one row per group with input/output tokens, estimated cost, and
call count. Rows are sorted by cost descending.

Examples:
  $ assistant usage breakdown
  $ assistant usage breakdown --group-by provider
  $ assistant usage breakdown --group-by actor --range week`,
    )
    .action(
      (opts: {
        range: string;
        from?: string;
        to?: string;
        json?: boolean;
        groupBy: string;
      }) => {
        const validDimensions = new Set([
          "actor",
          "provider",
          "model",
          "conversation",
        ]);
        if (!validDimensions.has(opts.groupBy)) {
          log.error(
            `Invalid --group-by value: '${opts.groupBy}'. Must be one of: actor, provider, model, conversation`,
          );
          process.exit(1);
        }
        getDb();
        const { from, to } = resolveRange(opts);
        const breakdown = getUsageGroupBreakdown(
          { from, to },
          opts.groupBy as "actor" | "provider" | "model" | "conversation",
        );
        if (opts.json) {
          log.info(JSON.stringify({ breakdown }, null, 2));
        } else {
          printBreakdownTable(breakdown, opts.groupBy);
        }
      },
    );
}

/** Resolve the time range from commander options. */
function resolveRange(opts: { range: string; from?: string; to?: string }): {
  from: number;
  to: number;
} {
  if (opts.from !== undefined || opts.to !== undefined) {
    const from = opts.from !== undefined ? Number(opts.from) : 0;
    const to = opts.to !== undefined ? Number(opts.to) : Date.now();
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      log.error("--from and --to must be valid epoch millisecond timestamps");
      process.exit(1);
    }
    if (from > to) {
      log.error("--from must be less than or equal to --to");
      process.exit(1);
    }
    return { from, to };
  }
  const validPresets = new Set<string>(["today", "week", "month", "all"]);
  if (!validPresets.has(opts.range)) {
    log.error(
      `Invalid --range value: '${opts.range}'. Must be one of: today, week, month, all`,
    );
    process.exit(1);
  }
  return resolveTimeRange(opts.range as RangePreset);
}
