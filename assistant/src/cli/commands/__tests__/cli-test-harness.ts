/**
 * Shared harness for CLI command tests: registers a command tree on a fresh
 * Commander program, runs it against captured output sinks, and returns what
 * the command emitted plus the resulting exit code.
 *
 * `process.stdout.write`, `console.log`, and `console.error` are captured for
 * the duration of the run, so command output lands in the result regardless of
 * which sink the command writes to; `process.exitCode` is reset afterwards.
 * The caller passes its own (possibly mock-backed) registration function, so
 * this helper imports nothing from `src/` beyond what any test file may
 * import itself (see the test-machinery isolation rules in assistant/CLAUDE.md).
 */

import { Command } from "commander";

export interface CliCommandRunResult {
  stdout: string;
  stderr: string;
  /** stdout + stderr chunks in emission order, for cross-stream ordering. */
  events: string[];
  exitCode: number;
}

export async function runCliCommand(
  register: (program: Command) => void,
  args: string[],
): Promise<CliCommandRunResult> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const events: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    stdoutChunks.push(text);
    events.push(text);
    return true;
  }) as typeof process.stdout.write;
  console.log = (...logArgs: unknown[]) => {
    const text = logArgs.map(String).join(" ") + "\n";
    stdoutChunks.push(text);
    events.push(text);
  };
  console.error = (...logArgs: unknown[]) => {
    const text = logArgs.map(String).join(" ") + "\n";
    stderrChunks.push(text);
    events.push(text);
  };

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    register(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) {
      process.exitCode = 1;
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    events,
    exitCode,
  };
}
