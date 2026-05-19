import { spawn } from "node:child_process";

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

    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    if (wantsStdin && child.stdin) {
      // end() flushes the buffered payload and closes stdin so the child
      // sees EOF — required for `python3 -` to stop reading and execute.
      child.stdin.end(opts!.stdin);
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve(closeExitCode(code, signal)));
    });

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

export function assertSuccess(
  result: CommandResult,
  description: string,
): void {
  if (result.exitCode === 0) return;
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = stderr || stdout || `exit code ${result.exitCode}`;
  throw new Error(`${description} failed: ${detail}`);
}
