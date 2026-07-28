import { buildSanitizedEnv } from "../tools/terminal/safe-env.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("run-script");

/** Maximum combined stdout + stderr captured (bytes). */
const MAX_OUTPUT_BYTES = 10_000;
/** Default timeout for script execution (ms) when a schedule sets no override. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Smallest script timeout override a caller may set (ms). */
export const MIN_SCRIPT_TIMEOUT_MS = 1_000;
/**
 * Largest script timeout override a caller may set (ms). Capped so a wedged
 * script cannot block the scheduler tick indefinitely; mirrors the talk-mode
 * budget in scheduler.ts.
 */
export const MAX_SCRIPT_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * How long to wait for the output pipes to drain after the process group is
 * killed before giving up (ms). A pipe only reaches EOF once every process
 * holding its write end has exited, so a child that escaped the group via
 * setsid could otherwise hold the pipe open forever and wedge the scheduler
 * tick.
 */
const DRAIN_TIMEOUT_MS = 5_000;

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
 *
 * The command runs in its own process group, and the whole group is killed
 * on timeout and swept after exit, so background children cannot outlive the
 * run. A child that daemonizes itself with setsid leaves the group and
 * deliberately survives.
 */
export async function runScript(
  command: string,
  options: {
    scheduleRunId: string;
    scheduleId: string;
    timeoutMs?: number;
    cwd?: string;
  },
): Promise<ScriptResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? getWorkspaceDir();

  log.info({ command, cwd, timeoutMs }, "Running script");

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...buildSanitizedEnv(),
      // __SCHEDULE_ID lets a saved command find its own dir; __SCHEDULE_RUN_ID
      // is the per-firing id (cost attribution). Required, so a script run is
      // always attributable and can locate its dir.
      __SCHEDULE_RUN_ID: options.scheduleRunId,
      __SCHEDULE_ID: options.scheduleId,
    },
  });

  // Start consuming streams immediately so buffered output is available even on timeout.
  // When the process group is killed the pipe fds close and these promises resolve on their own.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc.pid);
      reject(new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    proc.exited.then(() => clearTimeout(timer));
  });

  let exitCode: number;
  try {
    exitCode = await Promise.race([proc.exited, timeoutPromise]);
  } catch (err) {
    if (!timedOut) throw err;
    // Collect whatever the process wrote before the group was killed.
    const [stdoutStr, stderrStr] = await drainStreams(
      stdoutPromise,
      stderrPromise,
    );
    const stdout = truncate(stdoutStr);
    const timeoutMsg = `Script timed out after ${timeoutMs}ms`;
    const stderr = truncate(
      stderrStr ? `${timeoutMsg}\n${stderrStr}` : timeoutMsg,
    );
    log.info(
      { command, timedOut: true, stdoutLen: stdout.length },
      "Script timed out",
    );
    return { exitCode: 124, stdout, stderr };
  }

  // Sweep anything the script left running. This reaps orphaned background
  // children and closes their copies of the pipe fds so the stream reads
  // below can reach EOF.
  killProcessGroup(proc.pid);

  const [stdoutStr, stderrStr] = await drainStreams(
    stdoutPromise,
    stderrPromise,
  );
  const stdout = truncate(stdoutStr);
  const stderr = truncate(stderrStr);

  log.info(
    { command, exitCode, stdoutLen: stdout.length, stderrLen: stderr.length },
    "Script completed",
  );

  return { exitCode, stdout, stderr };
}

/**
 * SIGKILL every process in the script's process group. The group is often
 * already empty, in which case the signal fails with ESRCH and there is
 * nothing to reap.
 */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Process group may have already exited.
  }
}

/**
 * Collect both output streams, giving up on any stream that has not reached
 * EOF within {@link DRAIN_TIMEOUT_MS}.
 */
function drainStreams(
  stdoutPromise: Promise<string>,
  stderrPromise: Promise<string>,
): Promise<[string, string]> {
  const giveUp = (): Promise<string> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(""), DRAIN_TIMEOUT_MS);
      timer.unref();
    });
  return Promise.all([
    Promise.race([stdoutPromise, giveUp()]),
    Promise.race([stderrPromise, giveUp()]),
  ]);
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)";
}

/**
 * Validate a caller-supplied script timeout override (ms). Returns an error
 * message when the value is not a positive integer within the allowed bounds,
 * or `null` when it is acceptable.
 */
export function validateScriptTimeoutMs(value: number): string | null {
  if (!Number.isInteger(value)) {
    return "timeout_ms must be an integer number of milliseconds";
  }
  if (value < MIN_SCRIPT_TIMEOUT_MS || value > MAX_SCRIPT_TIMEOUT_MS) {
    return `timeout_ms must be between ${MIN_SCRIPT_TIMEOUT_MS} and ${MAX_SCRIPT_TIMEOUT_MS} (ms)`;
  }
  return null;
}
