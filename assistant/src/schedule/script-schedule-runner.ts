/**
 * Script-mode schedule execution: run the schedule's shell command and record
 * the outcome, retrying per the schedule's retry policy on failure.
 *
 * Shared by the in-process scheduler and the schedule worker process
 * (`worker.ts`) — script runs are self-contained (shell + schedule store, no
 * agent pipeline), which is what lets the worker own them out of process when
 * `schedules.worker.enabled` is set.
 */

import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import { getLogger } from "../util/logger.js";
import { handleScheduleExecutionFailure } from "./execution-failure.js";
import { runScript, type ScriptResult } from "./run-script.js";
import {
  claimDueSchedules,
  completeOneShot,
  completeScheduleRun,
  createScheduleRun,
  type ScheduleJob,
} from "./schedule-store.js";

const log = getLogger("script-schedule-runner");

export type ScriptScheduleOutcome = "completed" | "failed" | "skipped";

/**
 * Execute one claimed script-mode schedule job. Returns how the run should be
 * tallied by the caller's tick counters.
 */
export async function runScriptScheduleJob(
  job: ScheduleJob,
): Promise<ScriptScheduleOutcome> {
  const isOneShot = job.expression == null;

  if (!job.script) {
    log.warn(
      { jobId: job.id, name: job.name },
      "Script schedule has no script command — skipping",
    );
    return "skipped";
  }

  const runId = await createScheduleRun(job.id, `script:${job.id}`);
  try {
    log.info(
      { jobId: job.id, name: job.name, isOneShot },
      "Executing script schedule",
    );
    const result: ScriptResult = await runScript(job.script, {
      timeoutMs: job.timeoutMs ?? undefined,
      scheduleRunId: runId,
      scheduleId: job.id,
    });
    await completeScheduleRun(runId, {
      status: result.exitCode === 0 ? "ok" : "error",
      output: result.stdout || undefined,
      error: result.stderr || undefined,
    });
    if (result.exitCode === 0) {
      if (isOneShot) {
        await completeOneShot(job.id);
      }
      return "completed";
    }
    const errorMsg = result.stderr || "Script exited with non-zero status";
    await handleScheduleExecutionFailure({ job, errorMsg, isOneShot });
    return "failed";
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, jobId: job.id, name: job.name, isOneShot },
      "Script schedule execution failed",
    );
    await completeScheduleRun(runId, { status: "error", error: errorMsg });
    await handleScheduleExecutionFailure({ job, errorMsg, isOneShot });
    return "failed";
  }
}

/**
 * The schedule worker's tick: claim due script-mode schedules and execute
 * them sequentially. Returns how many were claimed. Claims are atomic in the
 * schedule store, so a daemon whose `schedules.worker.enabled` flag lags a
 * tick behind cannot double-run a job this loop claimed.
 */
export async function runScriptSchedulesOnce(
  now: number = Date.now(),
): Promise<number> {
  const diskPressureGate = checkDiskPressureBackgroundGate("background-work");
  if (diskPressureGate.action === "skip") {
    if (shouldLogDiskPressureBackgroundSkip("script-schedule-runner")) {
      log.warn(
        {
          source: "schedule",
          ...diskPressureBackgroundSkipLogFields(diskPressureGate),
        },
        "Schedule worker tick skipped during disk pressure cleanup mode",
      );
    }
    return 0;
  }

  const jobs = await claimDueSchedules(now, { includeModes: ["script"] });
  for (const job of jobs) {
    await runScriptScheduleJob(job);
  }
  return jobs.length;
}
