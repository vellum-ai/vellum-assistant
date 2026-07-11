import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { formatCostUsd } from "../lib/cli-output.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { usageHelp } from "./usage.help.js";

// ── Formatting helpers ───────────────────────────────────────────

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
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

// ── Response interfaces ─────────────────────────────────────────

interface UsageTotals {
  totalEstimatedCostUsd: number;
  eventCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  unpricedEventCount: number;
}

interface UsageDayBucket {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

interface UsageGroupBreakdown {
  group: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

// ── Table printers ───────────────────────────────────────────────

function printTotalsTable(totals: UsageTotals): void {
  log.info("");
  log.info("  Usage Totals");
  log.info("  ────────────────────────────────────");
  log.info(
    `  Estimated Cost     ${formatCostUsd(totals.totalEstimatedCostUsd)}`,
  );
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
    ...buckets.map((b) => formatCostUsd(b.totalEstimatedCostUsd).length),
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
      `  ${pad(b.date, dateW)}  ${pad(formatTokens(b.totalInputTokens), inputW, "right")}  ${pad(formatTokens(b.totalOutputTokens), outputW, "right")}  ${pad(formatCostUsd(b.totalEstimatedCostUsd), costW, "right")}  ${pad(String(b.eventCount), callsW, "right")}`,
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

  const groupLabel =
    groupBy === "call_site"
      ? "TASK"
      : groupBy === "inference_profile"
        ? "PROFILE"
        : groupBy.toUpperCase();
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
    ...entries.map((e) => formatCostUsd(e.totalEstimatedCostUsd).length),
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
      `  ${pad(e.group, groupW)}  ${pad(formatTokens(e.totalInputTokens), inputW, "right")}  ${pad(formatTokens(e.totalOutputTokens), outputW, "right")}  ${pad(formatCostUsd(e.totalEstimatedCostUsd), costW, "right")}  ${pad(String(e.eventCount), callsW, "right")}`,
    );
  }
  log.info("");
}

// ── Command registration ─────────────────────────────────────────

const VALID_GROUP_BY_DIMENSIONS = [
  "call_site",
  "inference_profile",
  "provider",
  "model",
  "conversation",
  "actor",
] as const;

export function registerUsageCommand(program: Command): void {
  registerCommand(program, {
    name: usageHelp.name,
    transport: "ipc",
    description: usageHelp.description,
    build: (usage) => {
      applyCommandHelp(usage, usageHelp);

      subcommand(usage, "totals").action(
        async (opts: {
          range: string;
          from?: string;
          to?: string;
          schedule?: string;
          json?: boolean;
        }) => {
          const { from, to } = resolveRange(opts);
          const response = await cliIpcCall<UsageTotals>("usage_totals", {
            queryParams: buildUsageQueryParams(from, to, opts.schedule),
          });
          if (!response.ok) {
            return exitFromIpcResult(response);
          }
          const totals = response.result!;
          if (opts.json) {
            log.info(JSON.stringify(totals, null, 2));
          } else {
            printTotalsTable(totals);
          }
        },
      );

      subcommand(usage, "daily").action(
        async (opts: {
          range: string;
          from?: string;
          to?: string;
          schedule?: string;
          json?: boolean;
        }) => {
          const { from, to } = resolveRange(opts);
          const response = await cliIpcCall<{ buckets: UsageDayBucket[] }>(
            "usage_daily",
            { queryParams: buildUsageQueryParams(from, to, opts.schedule) },
          );
          if (!response.ok) {
            return exitFromIpcResult(response);
          }
          const { buckets } = response.result!;
          if (opts.json) {
            log.info(JSON.stringify({ buckets }, null, 2));
          } else {
            printDailyTable(buckets);
          }
        },
      );

      subcommand(usage, "breakdown").action(
        async (opts: {
          range: string;
          from?: string;
          to?: string;
          schedule?: string;
          json?: boolean;
          groupBy: string;
        }) => {
          const validDimensions = new Set<string>(VALID_GROUP_BY_DIMENSIONS);
          if (!validDimensions.has(opts.groupBy)) {
            log.error(
              `Invalid --group-by value: '${opts.groupBy}'. Must be one of: ${VALID_GROUP_BY_DIMENSIONS.join(", ")}`,
            );
            process.exit(1);
          }
          const { from, to } = resolveRange(opts);
          const response = await cliIpcCall<{
            breakdown: UsageGroupBreakdown[];
          }>("usage_breakdown", {
            queryParams: {
              ...buildUsageQueryParams(from, to, opts.schedule),
              groupBy: opts.groupBy,
            },
          });
          if (!response.ok) {
            return exitFromIpcResult(response);
          }
          const { breakdown } = response.result!;
          if (opts.json) {
            log.info(JSON.stringify({ breakdown }, null, 2));
          } else {
            printBreakdownTable(breakdown, opts.groupBy);
          }
        },
      );
    },
  });
}

/**
 * Build the shared usage query params, including scheduleId only when a
 * schedule filter is provided.
 */
function buildUsageQueryParams(
  from: number,
  to: number,
  schedule?: string,
): Record<string, string> {
  const queryParams: Record<string, string> = {
    from: String(from),
    to: String(to),
  };
  if (schedule !== undefined) {
    queryParams.scheduleId = schedule;
  }
  return queryParams;
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
