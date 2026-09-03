export interface AssistantCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Stand-in for `exitFromIpcResult` in a `mock.module` factory. The real one
 * ends the process, which would take the test runner with it. Same stderr line
 * and same exit code, and the caller carries on to its own early return.
 *
 * The code mapping is spelled out rather than imported: suites load this helper
 * before installing their `mock.module` replacement, so importing the IPC
 * client here would pull the real module and its import-time work into test
 * setup. It mirrors `exitCodeFromIpcResult` in `ipc/cli-client.ts`.
 */
export function reportIpcFailureWithoutExiting(r: {
  error?: string;
  statusCode?: number;
}): void {
  process.stderr.write((r.error ?? "Unknown error") + "\n");
  const status = r.statusCode;
  if (status === undefined) {
    process.exitCode = 10;
  } else if (status >= 500) {
    process.exitCode = 3;
  } else if (status >= 400) {
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
}

/**
 * Collect a stream's writes into `chunks`. The override must invoke the
 * callback (when provided) so that `Writable` streams piped into the real
 * stream (e.g. pino's CLI destination) can drain: without it only the first
 * write lands and the rest hang in backpressure. The second argument can be
 * either an encoding string or the callback.
 */
function captureWrites(chunks: string[]): typeof process.stdout.write {
  return ((
    chunk: string | Uint8Array,
    encoding?: unknown,
    cb?: (err?: Error | null) => void,
  ) => {
    chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    const callback = typeof encoding === "function" ? encoding : cb;
    if (typeof callback === "function") {
      callback();
    }
    return true;
  }) as typeof process.stdout.write;
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
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = captureWrites(stdoutChunks);
  // `writeError` reaches process.stderr directly, so commander's `writeErr`
  // alone would miss a command's own error output.
  process.stderr.write = captureWrites(stderrChunks);

  try {
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    /* commander exit override throws */
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
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
