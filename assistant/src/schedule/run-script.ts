import { buildSanitizedEnv } from "../tools/terminal/safe-env.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import {
  checkPinnedSkillVersion,
  resolveScheduleSkill,
  stampScheduleSkillUsage,
} from "./skill-binding.js";

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
  options: {
    scheduleRunId: string;
    scheduleId: string;
    timeoutMs?: number;
    cwd?: string;
    /**
     * Absolute directory of the managed skill this schedule is bound to,
     * exposed to the command as `$__SKILL_DIR`. Resolved per firing rather
     * than baked into the saved command, so the binding survives a workspace
     * move or a reinstall that changes the skill's absolute path.
     */
    skillDir?: string;
  },
): Promise<ScriptResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? getWorkspaceDir();

  log.info({ command, cwd, timeoutMs }, "Running script");

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...buildSanitizedEnv(),
      // __SCHEDULE_ID lets a saved command find its own dir; __SCHEDULE_RUN_ID
      // is the per-firing id (cost attribution). Required, so a script run is
      // always attributable and can locate its dir.
      __SCHEDULE_RUN_ID: options.scheduleRunId,
      __SCHEDULE_ID: options.scheduleId,
      ...(options.skillDir ? { __SKILL_DIR: options.skillDir } : {}),
    },
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
    const stderr = truncate(
      stderrStr ? `${timeoutMsg}\n${stderrStr}` : timeoutMsg,
    );
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

export type BoundScriptOutcome =
  | { ok: true; result: ScriptResult }
  | { ok: false; error: string };

/**
 * Run a schedule's script with its skill binding enforced.
 *
 * Shared by the scheduler's firing path and the manual `run now` route so a
 * skill-bound schedule can never execute through one of them with a stale
 * approval. On success the bound skill's `lastUsedAt` is stamped, which is
 * what keeps a schedule-only skill out of the memory maintenance prune.
 */
export async function runScheduleScript(
  job: {
    id: string;
    script: string;
    timeoutMs: number | null;
    skillId: string | null;
    skillVersionHash: string | null;
  },
  runId: string,
): Promise<BoundScriptOutcome> {
  let skillDir: string | undefined;

  if (job.skillId) {
    const resolved = resolveScheduleSkill(job.skillId);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const versionError = checkPinnedSkillVersion({
      skillId: job.skillId,
      pinnedHash: job.skillVersionHash,
      currentHash: resolved.skill.versionHash,
    });
    if (versionError) return { ok: false, error: versionError };
    skillDir = resolved.skill.skillDir;
  }

  const result = await runScript(job.script, {
    timeoutMs: job.timeoutMs ?? undefined,
    scheduleRunId: runId,
    scheduleId: job.id,
    ...(skillDir ? { skillDir } : {}),
  });

  if (result.exitCode === 0 && job.skillId && skillDir) {
    stampScheduleSkillUsage(job.skillId, skillDir);
  }

  return { ok: true, result };
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
