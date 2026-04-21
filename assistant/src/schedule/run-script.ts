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

  // Race process completion against a timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    // Clean up timer if process finishes first
    proc.exited.then(() => clearTimeout(timer));
  });

  const exitCode = await Promise.race([proc.exited, timeoutPromise]);

  const stdout = truncate(await new Response(proc.stdout).text());
  const stderr = truncate(await new Response(proc.stderr).text());

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
