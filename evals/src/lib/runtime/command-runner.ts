import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import { formatProgressTimestamp } from "../runner/progress";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnedProcess {
  pid?: number;
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface RunOptions {
  env?: Record<string, string>;
  cwd?: string;
  /**
   * UTF-8 string written to the child's stdin before it's closed. Used by
   * the Hermes seed helper to pipe a JSON payload into an inline
   * `docker exec -i ... python3 -` script without command-line escaping.
   * When omitted, the child gets no stdin (legacy behavior).
   */
  stdin?: string;
  /**
   * Optional file path to write a structured per-line log of the child's
   * stdout + stderr as it runs. Each completed line is timestamped and
   * tagged using the same `[YYYY-MM-DD HH:MM:SS] [step] glyph msg` layout
   * the eval test runner uses (see `formatSubprocessLogLine`), so the
   * report UI can inline subprocess logs in the same shape as runner
   * logs. Both streams are also buffered in memory as before, so the
   * existing `CommandResult.stdout/stderr` contract is preserved.
   *
   * Best-effort: log-file write failures never interrupt the run or
   * mutate the returned `CommandResult`.
   */
  logPath?: string;
  /**
   * Label embedded in the `[step]` slot of each line in the on-disk log.
   * Defaults to a value derived from `logPath` (e.g. `subprocess-hatch.log`
   * → `hatch`, `subprocess-setup-2.log` → `setup-2`) so the most common
   * call sites don't need to repeat themselves.
   */
  logStep?: string;
  /**
   * Clock for the per-line subprocess log timestamps. Defaults to a fresh
   * `Date` per line. Injected for deterministic tests.
   */
  now?: () => Date;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<CommandResult>;
  spawn(
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; cwd?: string },
  ): SpawnedProcess;
}

function closeExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  return signal ? 128 : 1;
}

async function* streamToStrings(
  stream: NodeJS.ReadableStream | null,
): AsyncGenerator<string> {
  if (!stream) return;
  for await (const chunk of stream) {
    yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
}

/**
 * Width used to pad the `[step]` slot in the subprocess log layout.
 *
 * Matches `STEP_LABEL_WIDTH` in `runner/progress.ts` so subprocess logs
 * and test-runner logs line up column-for-column when rendered side by
 * side in the report UI. Duplicated as a literal (rather than imported)
 * because progress.ts keeps it module-private; bumping one means bumping
 * the other.
 */
const SUBPROCESS_STEP_LABEL_WIDTH = 11;

/**
 * Status glyph used in the subprocess log layout.
 *
 *   `•` (info) for stdout lines
 *   `✗` (error) for stderr lines
 *
 * Mirrors the `STATUS_GLYPHS` map in `runner/progress.ts`. Subprocess
 * lines never carry the other statuses (`start` / `done`) — those only
 * make sense for the runner's typed step lifecycle.
 */
const SUBPROCESS_GLYPHS = {
  info: "\u2022",
  error: "\u2717",
} as const;

export type SubprocessLogStatus = keyof typeof SUBPROCESS_GLYPHS;

export interface FormatSubprocessLogLineInput {
  /** Timestamp captured at the moment the line was emitted. */
  ts: Date;
  /** Label embedded in the `[step]` slot. */
  step: string;
  /** `info` (stdout) or `error` (stderr). */
  status: SubprocessLogStatus;
  /** Raw line content. Newlines should already be stripped. */
  line: string;
}

/**
 * Format a single subprocess log line in the same layout the eval test
 * runner uses for its own progress events (`[ts] [step] glyph msg`).
 *
 * Exported so call sites and tests share the canonical formatter — the
 * report-html parser depends on this exact shape.
 */
export function formatSubprocessLogLine(
  input: FormatSubprocessLogLineInput,
): string {
  const ts = formatProgressTimestamp(input.ts);
  const label = `[${input.step}]`.padEnd(SUBPROCESS_STEP_LABEL_WIDTH, " ");
  const glyph = SUBPROCESS_GLYPHS[input.status];
  return `[${ts}] ${label} ${glyph} ${input.line}`;
}

/**
 * Derive a default `[step]` label from a `logPath` like
 * `.runs/<id>/subprocess-hatch.log` → `hatch`,
 * `.runs/<id>/subprocess-setup-2.log` → `setup-2`. Anything that
 * doesn't match the `subprocess-*.log` convention falls back to
 * `subprocess` so we never emit an empty bracket pair.
 *
 * Exported for tests.
 */
export function deriveStepFromLogPath(logPath: string): string {
  const baseStart = logPath.lastIndexOf("/") + 1;
  const base = logPath.slice(baseStart);
  const match = base.match(/^subprocess-(.+)\.log$/);
  return match ? match[1] : "subprocess";
}

/**
 * Buffer arriving stream chunks and yield complete lines as they finish.
 *
 * Why a class and not `split("\n")` over a string accumulator?
 *   - `push()` is called for every `data` event on stdout/stderr. A
 *     16 KiB stdout payload that doesn't end with `\n` MUST be held
 *     pending the next chunk — naive splitting on each chunk would
 *     fragment the line and double-timestamp the pieces.
 *   - `flush()` is called once at EOF to emit any trailing partial line
 *     (a child that prints to stderr and then crashes mid-write would
 *     otherwise drop its last message from the log entirely).
 *   - `\r\n` line endings (Windows / cross-platform docker output) are
 *     normalized to `\n`-terminated lines.
 *
 * Exported for tests.
 */
export class LineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      // Normalize CRLF — drop a trailing `\r` so the on-disk log doesn't
      // carry stray carriage returns that confuse the report parser.
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
      this.buffer = this.buffer.slice(idx + 1);
    }
    return lines;
  }

  flush(): string | null {
    if (this.buffer.length === 0) return null;
    let tail = this.buffer;
    this.buffer = "";
    if (tail.endsWith("\r")) tail = tail.slice(0, -1);
    return tail.length > 0 ? tail : null;
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<CommandResult> {
    const wantsStdin = opts?.stdin !== undefined;
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      // When stdin is supplied, open it as a pipe so we can write +
      // close. Default ("ignore") preserves the legacy contract for the
      // 30+ existing call sites that don't need stdin.
      stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    // Logged lines go through the per-line formatter so each entry in
    // the on-disk file carries its own timestamp + step + glyph. The
    // raw `stdoutChunks/stderrChunks` arrays still capture everything
    // verbatim for the in-memory `CommandResult` contract.
    const logLines: string[] = [];
    const logStep = opts?.logPath
      ? (opts.logStep ?? deriveStepFromLogPath(opts.logPath))
      : "subprocess";
    const now = opts?.now ?? (() => new Date());
    const stdoutBuffer = new LineBuffer();
    const stderrBuffer = new LineBuffer();

    const emitLines = (lines: string[], status: SubprocessLogStatus): void => {
      if (!opts?.logPath) return;
      for (const line of lines) {
        logLines.push(
          formatSubprocessLogLine({ ts: now(), step: logStep, status, line }),
        );
      }
    };

    child.stdout?.on("data", (chunk) => {
      const str = chunk.toString();
      stdoutChunks.push(str);
      if (opts?.logPath) emitLines(stdoutBuffer.push(str), "info");
    });
    child.stderr?.on("data", (chunk) => {
      const str = chunk.toString();
      stderrChunks.push(str);
      if (opts?.logPath) emitLines(stderrBuffer.push(str), "error");
    });

    if (wantsStdin && child.stdin) {
      // end() flushes the buffered payload and closes stdin so the child
      // sees EOF — required for `python3 -` to stop reading and execute.
      child.stdin.end(opts!.stdin);
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve(closeExitCode(code, signal)));
    });

    // Flush any partial trailing lines so a child that crashed mid-write
    // still leaves its last bytes in the log.
    if (opts?.logPath) {
      const stdoutTail = stdoutBuffer.flush();
      if (stdoutTail !== null) emitLines([stdoutTail], "info");
      const stderrTail = stderrBuffer.flush();
      if (stderrTail !== null) emitLines([stderrTail], "error");
      const body = logLines.length > 0 ? logLines.join("\n") + "\n" : "";
      void writeFile(opts.logPath, body).catch(() => undefined);
    }

    return {
      exitCode,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  }

  spawn(
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; cwd?: string },
  ): SpawnedProcess {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      pid: child.pid,
      stdout: streamToStrings(child.stdout),
      stderr: streamToStrings(child.stderr),
      wait: () =>
        new Promise<number>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) =>
            resolve(closeExitCode(code, signal)),
          );
        }),
      kill: (signal = "SIGTERM") => child.kill(signal),
    };
  }
}

/**
 * Thrown by `assertSuccess` when a subprocess returns a non-zero exit
 * code. Carries the original `CommandResult` so the catch site can
 * surface structured diagnostics (last N stderr / stdout lines, exit
 * code) without having to re-parse `err.message`.
 */
export class SubprocessFailedError extends Error {
  readonly description: string;
  readonly result: CommandResult;

  constructor(description: string, result: CommandResult) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const detail = stderr || stdout || `exit code ${result.exitCode}`;
    super(`${description} failed: ${detail}`);
    this.name = "SubprocessFailedError";
    this.description = description;
    this.result = result;
  }
}

export function assertSuccess(
  result: CommandResult,
  description: string,
): void {
  if (result.exitCode === 0) return;
  throw new SubprocessFailedError(description, result);
}
