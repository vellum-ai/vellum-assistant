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

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; cwd?: string },
  ): Promise<CommandResult>;
  spawn(
    command: string,
    args: string[],
    opts?: { env?: Record<string, string>; cwd?: string },
  ): SpawnedProcess;
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
    opts?: { env?: Record<string, string>; cwd?: string },
  ): Promise<CommandResult> {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk.toString()));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 0));
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
          child.on("close", (code) => resolve(code ?? 0));
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
