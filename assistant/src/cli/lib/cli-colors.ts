/**
 * Minimal ANSI red wrapper for CLI error output. Respects `NO_COLOR`
 * (https://no-color.org/) and skips coloring when stderr is not a TTY so
 * piped/captured output stays clean.
 */
export function red(text: string): string {
  if (!process.stderr.isTTY) return text;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return text;
  }
  return `\x1b[31m${text}\x1b[0m`;
}
