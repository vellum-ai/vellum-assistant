import type { BackgroundJobErrorKind } from "../runtime/background-job-runner.js";

/**
 * Dedupe key for a background-job failure notification.
 *
 * Provider-level failures (a billing lapse, a revoked managed key, a provider
 * outage) share one root cause across every job they hit, so they key on the
 * cause and collapse into a single notification per UTC day, however many
 * jobs fail. Job-specific failures (timeouts, generic exceptions) keep the
 * per-job key so one job's failure cannot swallow the visibility of
 * another's.
 *
 * Shared by every `activity.failed` producer that reports a classified
 * background failure (the background-job runner, and the scheduler's
 * retries-exhausted alert), so a schedule exhausting on the same cause as an
 * already-reported job failure does not produce a second notification.
 */
export function activityFailedDedupeKey(args: {
  jobName: string;
  errorKind: BackgroundJobErrorKind;
  failureCode?: string;
}): string {
  const day = new Date().toISOString().slice(0, 10);
  if (args.failureCode) {
    return `activity-failed:cause:${args.failureCode}:${day}`;
  }
  if (args.errorKind === "model_provider") {
    return `activity-failed:cause:model_provider:${day}`;
  }
  return `activity-failed:${args.jobName}:${day}`;
}
