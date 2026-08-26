import type { ConversationErrorCode } from "../api/events/conversation-error.js";
import type { BackgroundJobErrorKind } from "../runtime/background-job-runner.js";

/**
 * Failure codes that describe the environment rather than the failing job:
 * every job they hit shares one root cause and one remedy (add credits, fix
 * the key, free disk, wait out the provider), so their notifications collapse
 * across jobs.
 *
 * Codes NOT listed here key per job on purpose. A code like
 * `CONTEXT_TOO_LARGE` or `MAX_TOKENS_REACHED` names a defect in one job's own
 * prompt or output, and collapsing it would hide a second job's unrelated
 * failure behind the first's notification. Unknown or future codes default to
 * per-job for the same reason: an extra notification is recoverable, a hidden
 * one is not.
 *
 * Typed against {@link ConversationErrorCode} so a renamed code fails the
 * build here instead of silently un-collapsing.
 */
const ENVIRONMENT_WIDE_FAILURE_CODES = new Set<string>([
  "PROVIDER_BILLING",
  "MANAGED_KEY_INVALID",
  "MANAGED_USAGE_LIMIT",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_INVALID_KEY",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_OVERLOADED",
  "PROVIDER_NETWORK",
  "PROVIDER_API",
  "DISK_SPACE_CRITICAL",
] satisfies ConversationErrorCode[]);

/**
 * Dedupe key for a background-job failure notification.
 *
 * Environment-wide failures (a billing lapse, a revoked managed key, a
 * provider outage) share one root cause across every job they hit, so they
 * key on the cause and collapse into a single notification per UTC day,
 * however many jobs fail. Job-specific failures (timeouts, generic
 * exceptions, and codes outside {@link ENVIRONMENT_WIDE_FAILURE_CODES}) keep
 * the per-job key so one job's failure cannot swallow the visibility of
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
    return ENVIRONMENT_WIDE_FAILURE_CODES.has(args.failureCode)
      ? `activity-failed:cause:${args.failureCode}:${day}`
      : `activity-failed:${args.jobName}:${day}`;
  }
  if (args.errorKind === "model_provider") {
    return `activity-failed:cause:model_provider:${day}`;
  }
  return `activity-failed:${args.jobName}:${day}`;
}
