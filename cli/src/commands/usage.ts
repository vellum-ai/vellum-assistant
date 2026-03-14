import { resolveTargetAssistant } from "../lib/assistant-config";
import { buildDaemonUrl } from "../lib/http-client";

// ── Types ────────────────────────────────────────────────────────

interface UsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
}

interface UsageDayBucket {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

interface UsageGroupBreakdownEntry {
  group: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  eventCount: number;
}

type Subcommand = "totals" | "daily" | "breakdown";
type RangePreset = "today" | "week" | "month" | "all";
type GroupByDimension = "actor" | "provider" | "model";

const VALID_SUBCOMMANDS = new Set<string>(["totals", "daily", "breakdown"]);
const VALID_RANGE_PRESETS = new Set<string>(["today", "week", "month", "all"]);
const VALID_GROUP_BY = new Set<string>(["actor", "provider", "model"]);

// ── Argument parsing ─────────────────────────────────────────────

interface ParsedArgs {
  subcommand: Subcommand;
  from: number;
  to: number;
  groupBy: GroupByDimension;
  json: boolean;
  assistantName?: string;
}

function resolveTimeRange(preset: RangePreset): { from: number; to: number } {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  switch (preset) {
    case "today":
      return { from: startOfToday.getTime(), to: now };
    case "week": {
      const weekAgo = new Date(startOfToday);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return { from: weekAgo.getTime(), to: now };
    }
    case "month": {
      const monthAgo = new Date(startOfToday);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return { from: monthAgo.getTime(), to: now };
    }
    case "all":
      return { from: 0, to: now };
  }
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let subcommand: Subcommand = "totals";
  let rangePreset: RangePreset = "today";
  let fromMs: number | null = null;
  let toMs: number | null = null;
  let groupBy: GroupByDimension = "model";
  let json = false;
  let assistantName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--json") {
      json = true;
    } else if ((arg === "--range" || arg === "-r") && args[i + 1]) {
      const value = args[++i];
      if (!VALID_RANGE_PRESETS.has(value)) {
        console.error(
          `Invalid range preset: '${value}'. Must be one of: today, week, month, all`,
        );
        process.exit(1);
      }
      rangePreset = value as RangePreset;
    } else if (arg === "--from" && args[i + 1]) {
      fromMs = Number(args[++i]);
      if (!Number.isFinite(fromMs)) {
        console.error("--from must be a valid epoch millisecond timestamp");
        process.exit(1);
      }
    } else if (arg === "--to" && args[i + 1]) {
      toMs = Number(args[++i]);
      if (!Number.isFinite(toMs)) {
        console.error("--to must be a valid epoch millisecond timestamp");
        process.exit(1);
      }
    } else if ((arg === "--group-by" || arg === "-g") && args[i + 1]) {
      const value = args[++i];
      if (!VALID_GROUP_BY.has(value)) {
        console.error(
          `Invalid group-by value: '${value}'. Must be one of: actor, provider, model`,
        );
        process.exit(1);
      }
      groupBy = value as GroupByDimension;
    } else if ((arg === "--name" || arg === "-n") && args[i + 1]) {
      assistantName = args[++i];
    } else if (!arg.startsWith("-") && VALID_SUBCOMMANDS.has(arg)) {
      subcommand = arg as Subcommand;
    } else if (!arg.startsWith("-")) {
      // Treat unknown positional as assistant name if subcommand already set
      assistantName = arg;
    }
  }

  let from: number;
  let to: number;
  if (fromMs !== null || toMs !== null) {
    from = fromMs ?? 0;
    to = toMs ?? Date.now();
  } else {
    const range = resolveTimeRange(rangePreset);
    from = range.from;
    to = range.to;
  }

  return { subcommand, from, to, groupBy, json, assistantName };
}

// ── HTTP helpers ─────────────────────────────────────────────────

async function fetchDaemonJson<T>(
  daemonPort: number,
  path: string,
  bearerToken?: string,
): Promise<T> {
  const url = `${buildDaemonUrl(daemonPort)}${path}`;
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Daemon API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

// ── Formatters ───────────────────────────────────────────────────

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

function printTotalsTable(totals: UsageTotals): void {
  console.log("");
  console.log("  Usage Totals");
  console.log("  ────────────────────────────────────");
  console.log(`  Estimated Cost     ${formatCost(totals.totalEstimatedCostUsd)}`);
  console.log(`  LLM Calls          ${totals.eventCount}`);
  console.log(`  Input Tokens       ${formatTokens(totals.totalInputTokens)}`);
  console.log(`  Output Tokens      ${formatTokens(totals.totalOutputTokens)}`);
  console.log(`  Cache Created      ${formatTokens(totals.totalCacheCreationTokens)}`);
  console.log(`  Cache Read         ${formatTokens(totals.totalCacheReadTokens)}`);
  if (totals.unpricedEventCount > 0) {
    console.log(`  Unpriced Events    ${totals.unpricedEventCount}`);
  }
  console.log("");
}

function printDailyTable(buckets: UsageDayBucket[]): void {
  if (buckets.length === 0) {
    console.log("\n  No usage data for the selected time range.\n");
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

  console.log("");
  console.log(
    `  ${pad("DATE", dateW)}  ${pad("INPUT", inputW, "right")}  ${pad("OUTPUT", outputW, "right")}  ${pad("COST", costW, "right")}  ${pad("CALLS", callsW, "right")}`,
  );
  console.log(
    `  ${"-".repeat(dateW)}  ${"-".repeat(inputW)}  ${"-".repeat(outputW)}  ${"-".repeat(costW)}  ${"-".repeat(callsW)}`,
  );

  for (const b of buckets) {
    console.log(
      `  ${pad(b.date, dateW)}  ${pad(formatTokens(b.totalInputTokens), inputW, "right")}  ${pad(formatTokens(b.totalOutputTokens), outputW, "right")}  ${pad(formatCost(b.totalEstimatedCostUsd), costW, "right")}  ${pad(String(b.eventCount), callsW, "right")}`,
    );
  }
  console.log("");
}

function printBreakdownTable(
  entries: UsageGroupBreakdownEntry[],
  groupBy: GroupByDimension,
): void {
  if (entries.length === 0) {
    console.log("\n  No usage data for the selected time range.\n");
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

  console.log("");
  console.log(
    `  ${pad(groupLabel, groupW)}  ${pad("INPUT", inputW, "right")}  ${pad("OUTPUT", outputW, "right")}  ${pad("COST", costW, "right")}  ${pad("CALLS", callsW, "right")}`,
  );
  console.log(
    `  ${"-".repeat(groupW)}  ${"-".repeat(inputW)}  ${"-".repeat(outputW)}  ${"-".repeat(costW)}  ${"-".repeat(callsW)}`,
  );

  for (const e of entries) {
    console.log(
      `  ${pad(e.group, groupW)}  ${pad(formatTokens(e.totalInputTokens), inputW, "right")}  ${pad(formatTokens(e.totalOutputTokens), outputW, "right")}  ${pad(formatCost(e.totalEstimatedCostUsd), costW, "right")}  ${pad(String(e.eventCount), callsW, "right")}`,
    );
  }
  console.log("");
}

// ── Help ─────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`Usage: vellum usage [subcommand] [options]

Query LLM token usage and cost data from a running assistant.

Subcommands:
  totals       Aggregate totals for the time range (default)
  daily        Per-day token and cost breakdown
  breakdown    Grouped breakdown by actor, provider, or model

Options:
  -r, --range <preset>   Time range preset: today, week, month, all (default: today)
  --from <epoch_ms>      Start of time range (epoch milliseconds)
  --to <epoch_ms>        End of time range (epoch milliseconds)
  -g, --group-by <dim>   Grouping for breakdown: actor, provider, model (default: model)
  -n, --name <name>      Target assistant name
  --json                 Output raw JSON
  -h, --help             Show this help

Examples:
  vellum usage                          Show today's totals
  vellum usage daily --range week       Daily breakdown for the last 7 days
  vellum usage breakdown -g provider    Breakdown by provider for today
  vellum usage totals --range all       All-time totals
  vellum usage daily --range month --json   JSON output for scripting`);
}

// ── Main ─────────────────────────────────────────────────────────

export async function usage(): Promise<void> {
  const parsed = parseArgs();
  const entry = resolveTargetAssistant(parsed.assistantName);

  if (!entry.resources) {
    console.error(
      `Error: Assistant '${entry.assistantId}' is missing resource configuration.`,
    );
    process.exit(1);
  }

  const daemonPort = entry.resources.daemonPort;
  const bearerToken = entry.bearerToken;
  const qs = `from=${parsed.from}&to=${parsed.to}`;

  try {
    switch (parsed.subcommand) {
      case "totals": {
        const totals = await fetchDaemonJson<UsageTotals>(
          daemonPort,
          `/v1/usage/totals?${qs}`,
          bearerToken,
        );
        if (parsed.json) {
          console.log(JSON.stringify(totals, null, 2));
        } else {
          printTotalsTable(totals);
        }
        break;
      }

      case "daily": {
        const data = await fetchDaemonJson<{ buckets: UsageDayBucket[] }>(
          daemonPort,
          `/v1/usage/daily?${qs}`,
          bearerToken,
        );
        if (parsed.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          printDailyTable(data.buckets);
        }
        break;
      }

      case "breakdown": {
        const data = await fetchDaemonJson<{
          breakdown: UsageGroupBreakdownEntry[];
        }>(
          daemonPort,
          `/v1/usage/breakdown?${qs}&groupBy=${parsed.groupBy}`,
          bearerToken,
        );
        if (parsed.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          printBreakdownTable(data.breakdown, parsed.groupBy);
        }
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(
        `Error: Could not connect to assistant '${entry.assistantId}'. Is it running? Try 'vellum wake'.`,
      );
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }
}
