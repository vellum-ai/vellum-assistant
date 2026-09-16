import type { Command } from "commander";

export function shouldOutputJson(cmd: Command): boolean {
  let current: Command | null = cmd;
  while (current) {
    if ((current.opts() as { json?: boolean }).json) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Write a JSON payload to stdout. `onFlushed` runs once the bytes have left
 * the process, for a command that must exit itself and would otherwise cut
 * a piped payload short.
 */
export function writeOutput(
  cmd: Command,
  payload: unknown,
  onFlushed?: () => void,
): void {
  const compact = shouldOutputJson(cmd);
  process.stdout.write(
    compact
      ? JSON.stringify(payload) + "\n"
      : JSON.stringify(payload, null, 2) + "\n",
    onFlushed,
  );
}

/** Format-aware error output: JSON envelope with --json, stderr otherwise. */
export function writeError(
  cmd: Command,
  message: string,
  onFlushed?: () => void,
): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: false, error: message }, onFlushed);
  } else {
    process.stderr.write(`Error: ${message}\n`, onFlushed);
  }
}
