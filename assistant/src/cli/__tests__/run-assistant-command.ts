export interface AssistantCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * CLI test utility — run an assistant CLI command via the real program,
 * capturing stdout and stderr.
 *
 * Returns both stdout and stderr. For backward compatibility, the function
 * is also callable with just a string return (use `runAssistantCommand`).
 */
export async function runAssistantCommandFull(
  ...args: string[]
): Promise<AssistantCommandResult> {
  const { buildCliProgram } = await import("../program.js");
  const program = await buildCliProgram();
  program.exitOverride();

  const stderrChunks: string[] = [];
  program.configureOutput({
    writeErr: (str: string) => stderrChunks.push(str),
    writeOut: () => {},
  });

  const stdoutChunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stdout.write;

  try {
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    /* commander exit override throws */
  } finally {
    process.stdout.write = originalWrite;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

/**
 * CLI test utility — run an assistant CLI command via the real program,
 * capturing stdout (backward-compatible wrapper).
 */
export async function runAssistantCommand(...args: string[]): Promise<string> {
  const result = await runAssistantCommandFull(...args);
  return result.stdout;
}
