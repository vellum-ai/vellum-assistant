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

export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) {
    return "0";
  }
  return Math.round(count).toLocaleString();
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) {
    return "$0.00";
  }
  return `$${usd.toFixed(2)}`;
}
