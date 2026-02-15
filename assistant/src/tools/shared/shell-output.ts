export const MAX_OUTPUT_LENGTH = 50_000;

export interface ShellOutputResult {
  content: string;
  status: string | undefined;
  isError: boolean;
}

/**
 * Format the raw stdout/stderr/exit-code from a spawned shell command into the
 * final tool result.  Both `shell.ts` (sandbox bash) and `host-shell.ts`
 * (host_bash) must produce identical output formatting — this shared function
 * is the single source of truth for that logic.
 */
export function formatShellOutput(
  stdout: string,
  stderr: string,
  code: number | null,
  timedOut: boolean,
  timeoutSec: number,
): ShellOutputResult {
  let output = stdout;
  if (stderr) {
    output += (output ? '\n' : '') + stderr;
  }

  const statusParts: string[] = [];

  if (timedOut) {
    const msg = `<command_timeout seconds="${timeoutSec}" />`;
    output += `\n${msg}`;
    statusParts.push(msg);
  }

  if (output.length > MAX_OUTPUT_LENGTH) {
    const msg = '<output_truncated limit="50K" />';
    output = output.slice(0, MAX_OUTPUT_LENGTH) + `\n${msg}`;
    statusParts.push(msg);
  }

  if (!output.trim()) {
    output = code === 0 ? '<command_completed />' : `<command_exit code="${code}" />`;
  } else if (code !== 0 && !timedOut) {
    statusParts.push(`<command_exit code="${code}" />`);
  }

  return {
    content: output,
    status: statusParts.length > 0 ? statusParts.join('\n') : undefined,
    isError: code !== 0 || timedOut,
  };
}
