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

export async function runRead(
  cmd: Command,
  reader: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await reader();
    writeOutput(cmd, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeOutput(cmd, { ok: false, error: message });
    process.exitCode = 1;
  }
}
