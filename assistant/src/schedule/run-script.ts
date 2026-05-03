import { buildSanitizedEnv } from "../tools/terminal/safe-env.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("run-script");

/** Maximum combined stdout + stderr captured (bytes). */
const MAX_OUTPUT_BYTES = 10_000;
/** Default timeout for script execution (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command and capture its output.
 *
 * Uses Bun.spawn with /bin/sh so the command string supports pipes,
 * redirects, and shell builtins. Output is truncated to
 * {@link MAX_OUTPUT_BYTES} to keep schedule_runs rows bounded.
 */
export async function runScript(
  command: string,
  options?: { timeoutMs?: number; cwd?: string },
): Promise<ScriptResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options?.cwd ?? getWorkspaceDir();

  log.info({ command, cwd, timeoutMs }, "Running script");

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: buildSanitizedEnv(),
  });

  // Start consuming streams immediately so buffered output is available even on timeout.
  // When the process is killed the pipe fds close and these promises resolve on their own.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
      reject(new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    proc.exited.then(() => clearTimeout(timer));
  });

  /** How long to wait for pipes to drain after SIGKILL before giving up. */
  const DRAIN_TIMEOUT_MS = 5_000;

  let exitCode: number;
  try {
    exitCode = await Promise.race([proc.exited, timeoutPromise]);
  } catch (err) {
    if (!timedOut) throw err;
    // Collect whatever the process wrote before it was killed.
    // Race each stream against a short drain window — if a background child
    // process inherited the pipe fd, the stream would otherwise never reach
    // EOF and block the scheduler tick indefinitely.
    const empty = (ms: number): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve(""), ms));
    const [stdoutStr, stderrStr] = await Promise.all([
      Promise.race([stdoutPromise, empty(DRAIN_TIMEOUT_MS)]),
      Promise.race([stderrPromise, empty(DRAIN_TIMEOUT_MS)]),
    ]);
    const stdout = truncate(stdoutStr);
    const timeoutMsg = `Script timed out after ${timeoutMs}ms`;
    const stderr = truncate(stderrStr ? `${timeoutMsg}\n${stderrStr}` : timeoutMsg);
    log.info(
      { command, timedOut: true, stdoutLen: stdout.length },
      "Script timed out",
    );
    return { exitCode: 124, stdout, stderr };
  }

  const stdout = truncate(await stdoutPromise);
  const stderr = truncate(await stderrPromise);

  log.info(
    { command, exitCode, stdoutLen: stdout.length, stderrLen: stderr.length },
    "Script completed",
  );

  return { exitCode, stdout, stderr };
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)";
}
