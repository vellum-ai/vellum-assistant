/**
 * Formatting utilities shared by the Logs and Usage tabs. Mirrors the
 * formatting behavior of the macOS LogsAndUsagePanel so numbers render the
 * same across platforms.
 */

export function formatTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return "";
  }
  const d = new Date(timestampMs);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatTimelineTimestamp(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    return "";
  }
  const d = new Date(timestampMs);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) {
    return "0";
  }
  return Math.round(count).toLocaleString();
}

export function formatTokensCombined(input: number, output: number): string {
  const total = (input ?? 0) + (output ?? 0);
  if (total >= 1000) {
    return `${(total / 1000).toFixed(1)}k`;
  }
  return total.toLocaleString();
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "--";
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) {
    return "$0.00";
  }
  return `$${usd.toFixed(2)}`;
}
