import { getLogger } from "../util/logger.js";
import { applyRetryDecision, decideRetry } from "./retry-policy.js";
import {
  completeScheduleRun,
  createScheduleRun,
  failOneShotPermanently,
  findStaleInFlightJobs,
  getSchedule,
  resetRetryCount,
  scheduleRetry,
} from "./schedule-store.js";

const log = getLogger("schedule-recovery");

/**
 * Recover schedules left in an inconsistent state by a prior process crash.
 * Called once at daemon startup, before the scheduler tick loop starts,
 * so all "firing" / "running" rows are definitively stale.
 */
export function recoverStaleSchedules(): number {
  const stale = findStaleInFlightJobs(0);
  if (stale.length === 0) return 0;

  log.info({ count: stale.length }, "Recovering stale in-flight schedules");

  let recovered = 0;
  for (const { jobId, staleRunId } of stale) {
    try {
      const job = getSchedule(jobId);
      if (!job) continue;

      const errorMsg =
        "Process terminated during execution (recovered on restart)";

      if (staleRunId) {
        completeScheduleRun(staleRunId, { status: "error", error: errorMsg });
      } else {
        const runId = createScheduleRun(jobId, `recovery:${jobId}`);
        completeScheduleRun(runId, { status: "error", error: errorMsg });
      }

      // Use the same retry-or-exhaust path as the scheduler
      const isOneShot = job.expression == null;
      const decision = decideRetry(job);
      applyRetryDecision({
        job,
        isOneShot,
        errorMsg,
        decision,
        scheduleRetry,
        failOneShotPermanently,
        resetRetryCount,
        emitAlert: () => {}, // no feed event on startup recovery
        log,
      });
      recovered++;
    } catch (err) {
      log.error({ err, jobId }, "Failed to recover stale schedule");
    }
  }

  log.info({ recovered }, "Stale schedule recovery complete");
  return recovered;
}
