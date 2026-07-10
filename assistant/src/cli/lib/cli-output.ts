/**
 * Shared stdout/error helpers for CLI subcommands that support a `--json`
 * mode: plain line output, a JSON-aware error writer that sets the exit
 * code, and a fixed-width table renderer for human-readable lists.
 */

import { log } from "../logger.js";

export function writeLine(msg: string): void {
  process.stdout.write(msg + "\n");
}

/**
 * Format a USD cost with variable precision: "$0.00" for zero, six decimal
 * places for sub-cent amounts, two decimal places otherwise.
 */
export function formatCostUsd(usd: number): string {
  if (usd === 0) {
    return "$0.00";
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(6)}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Report a CLI failure and set `process.exitCode = 1`. In `--json` mode the
 * error is emitted to stdout as `{ ok: false, error }` so machine callers
 * always get a parseable body; otherwise it goes through the CLI logger.
 */
export function writeCliError(message: string, json?: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  } else {
    log.error(message);
  }
  process.exitCode = 1;
}

/** Render rows as a left-aligned fixed-width table with a header row. */
export function renderTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? "").padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  writeLine(fmt(headers));
  for (const row of rows) {
    writeLine(fmt(row));
  }
}
