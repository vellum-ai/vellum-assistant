import type { Command } from "commander";

export function shouldOutputJson(cmd: Command): boolean {
  let current: Command | null = cmd;
  while (current) {
    if ((current.opts() as { json?: boolean }).json) return true;
    current = current.parent;
  }
  return false;
}

export function writeOutput(cmd: Command, payload: unknown): void {
  const compact = shouldOutputJson(cmd);
  process.stdout.write(
    compact
      ? JSON.stringify(payload) + "\n"
      : JSON.stringify(payload, null, 2) + "\n",
  );
}

/** Format-aware error output: JSON envelope with --json, stderr otherwise. */
export function writeError(cmd: Command, message: string): void {
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: false, error: message });
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
}
