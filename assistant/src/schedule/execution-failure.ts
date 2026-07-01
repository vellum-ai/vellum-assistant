/**
 * Retry/exhaustion handling for failed schedule executions, shared by every
 * schedule mode in the in-process scheduler and by the schedule worker
 * process's script runs.
 */

import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { getLogger } from "../util/logger.js";
import { applyRetryDecision, decideRetry } from "./retry-policy.js";
import {
  failOneShotPermanently,
  resetRetryCount,
  type ScheduleJob,
  scheduleRetry,
} from "./schedule-store.js";

const log = getLogger("schedule-execution-failure");

/**
 * Apply retry policy on schedule-execution failure. Retries are scheduled by
 * `applyRetryDecision`; once retries are exhausted, the `emitAlert` callback
 * fires an `activity.failed` notification so the user sees that a job
 * permanently failed rather than just silently disappearing.
 */
export async function handleScheduleExecutionFailure(params: {
  job: ScheduleJob;
  errorMsg: string;
  isOneShot: boolean;
}): Promise<void> {
  const decision = decideRetry(params.job);
  await applyRetryDecision({
    job: params.job,
    isOneShot: params.isOneShot,
    errorMsg: params.errorMsg,
    decision,
    scheduleRetry,
    failOneShotPermanently,
    resetRetryCount,
    emitAlert: (_title, _summary, dedupKey) =>
      emitScheduleActivityFailed({
        jobId: params.job.id,
        jobName: params.job.name,
        errorMessage: params.errorMsg,
        dedupKey,
      }),
    log,
  });
}

/**
 * Emit an `activity.failed` notification for a schedule whose retries have
 * been exhausted. Fires once when the retry policy has given up, so the
 * dedupeKey is the per-attempt key passed in by `applyRetryDecision` (already
 * includes the job id and a timestamp). Fire-and-forget — a notification
 * failure must never break scheduler operation.
 */
function emitScheduleActivityFailed(args: {
  jobId: string;
  jobName: string;
  errorMessage: string;
  dedupKey: string;
}): void {
  emitNotificationSignal({
    sourceChannel: "scheduler",
    sourceContextId: args.jobId,
    sourceEventName: "activity.failed",
    dedupeKey: args.dedupKey,
    contextPayload: {
      jobName: `schedule:${args.jobName}`,
      errorMessage: args.errorMessage,
      errorKind: "exception",
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  }).catch((emitErr) => {
    log.warn(
      {
        err: emitErr instanceof Error ? emitErr.message : String(emitErr),
        jobId: args.jobId,
      },
      "Failed to emit activity.failed notification for exhausted schedule",
    );
  });
}
