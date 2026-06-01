/**
 * Shared formatters for `assistant db` subcommands. Inlined here (rather than
 * importing from a sibling command) so the `db` directory is self-contained
 * and the formatting choices stay consistent across status / repair / future
 * subcommands.
 */

/** Format a byte count as a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Format a number with thousands separators (1234567 → "1,234,567"). */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Short relative age: "32s ago", "12m ago", "3h ago", "5d ago". */
export function formatAge(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Format an epoch-ms timestamp as `YYYY-MM-DD HH:MM:SS UTC`. */
export function formatTimestampUtc(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const da = d.getUTCDate().toString().padStart(2, "0");
  const h = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const se = d.getUTCSeconds().toString().padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}:${se} UTC`;
}

/** Format a file mode (st_mode lower bits) as octal, e.g. "0644". */
export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}
