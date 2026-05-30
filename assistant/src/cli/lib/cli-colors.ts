/**
 * Minimal ANSI color wrappers for CLI output. Each helper respects `NO_COLOR`
 * (https://no-color.org/) and skips coloring when the relevant stream is not
 * a TTY so piped/captured output stays clean.
 *
 * `red` / `green` gate on stderr (error/success lines tend to land there in
 * the existing commands), `dim` gates on stdout (used for muted body text).
 */

function colorsDisabled(): boolean {
  return process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
}

export function red(text: string): string {
  if (!process.stderr.isTTY) return text;
  if (colorsDisabled()) return text;
  return `\x1b[31m${text}\x1b[0m`;
}

export function green(text: string): string {
  if (!process.stderr.isTTY) return text;
  if (colorsDisabled()) return text;
  return `\x1b[32m${text}\x1b[0m`;
}

export function dim(text: string): string {
  if (!process.stdout.isTTY) return text;
  if (colorsDisabled()) return text;
  return `\x1b[2m${text}\x1b[0m`;
}
