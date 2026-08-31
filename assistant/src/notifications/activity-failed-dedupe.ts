import type { ConversationErrorCode } from "../api/events/conversation-error.js";
import type { BackgroundJobErrorKind } from "../runtime/background-job-runner.js";

/**
 * Failure codes whose cause is the whole workspace: the managed route and the
 * local machine exist once, so every job they hit shares one root cause and
 * one remedy, whatever provider or profile the job used. These collapse into
 * a single notification per cause per UTC day.
 *
 * Typed against {@link ConversationErrorCode} so a renamed code fails the
 * build here instead of silently un-collapsing.
 */
const WORKSPACE_WIDE_FAILURE_CODES = new Set<string>([
  "MANAGED_KEY_INVALID",
  "MANAGED_USAGE_LIMIT",
  "DISK_SPACE_CRITICAL",
] satisfies ConversationErrorCode[]);

/**
 * Failure codes whose cause is one provider account or connection: a billing
 * lapse, a rejected key, a rate limit, an outage. One workspace can hold
 * several provider connections with independent remedies, so these collapse
 * only within a provider scope (see {@link activityFailedDedupeKey}), never
 * across scopes where the first failure would hide a second one that needs a
 * different fix.
 *
 * Codes in NEITHER set key per job on purpose. A code like
 * `CONTEXT_TOO_LARGE` or `MAX_TOKENS_REACHED` names a defect in one job's own
 * prompt or output, and collapsing it would hide a second job's unrelated
 * failure behind the first's notification. Unknown or future codes default to
 * per-job for the same reason: an extra notification is recoverable, a hidden
 * one is not.
 */
const PROVIDER_SCOPED_FAILURE_CODES = new Set<string>([
  "PROVIDER_BILLING",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_INVALID_KEY",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_OVERLOADED",
  "PROVIDER_NETWORK",
  "PROVIDER_API",
] satisfies ConversationErrorCode[]);

/**
 * Dedupe key for a background-job failure notification.
 *
 * Workspace-wide failures collapse into one notification per cause per UTC
 * day, however many jobs fail. Provider-scoped failures collapse within one
 * provider scope per day, so two provider connections failing for the same
 * class of reason still surface separately (their remedies differ).
 * Job-specific failures (timeouts, generic exceptions, and unlisted codes)
 * keep the per-job key so one job's failure cannot swallow the visibility of
 * another's.
 *
 * `providerScope` is the inference-profile key the failing call actually
 * resolved through, and only when that key names a single provider route
 * (both producers derive it via `resolveSingleRouteProfileKey`; a mix
 * winner has no single route). Callers that cannot name a trustworthy scope
 * omit it, and provider-scoped failures then key per job:
 * an extra notification is recoverable, while a false collapse across two
 * provider routes hides a failure whose remedy differs. The profile is a
 * transitional stand-in for the provider connection the failure actually hit:
 * one profile resolves to one connection at a time, so scoping by profile can
 * split one incident across profiles that share a connection but cannot merge
 * two connections' incidents. Once the turn boundary carries the classified
 * `connectionName` (today it keeps only the code), this scope should become
 * the connection itself.
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
  providerScope?: string;
}): string {
  const day = new Date().toISOString().slice(0, 10);
  const scope = args.providerScope;
  if (args.failureCode) {
    if (WORKSPACE_WIDE_FAILURE_CODES.has(args.failureCode)) {
      return `activity-failed:cause:${args.failureCode}:${day}`;
    }
    if (PROVIDER_SCOPED_FAILURE_CODES.has(args.failureCode) && scope) {
      return `activity-failed:cause:${args.failureCode}:${scope}:${day}`;
    }
    return `activity-failed:${args.jobName}:${day}`;
  }
  if (args.errorKind === "model_provider" && scope) {
    return `activity-failed:cause:model_provider:${scope}:${day}`;
  }
  return `activity-failed:${args.jobName}:${day}`;
}
