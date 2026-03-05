/**
 * Slack error classification for smarter retry and error handling decisions.
 *
 * Maps Slack API error codes to semantic categories so callers can decide
 * whether to retry, surface a user-facing message, or escalate.
 */

export type SlackErrorCategory =
  | "auth"
  | "rate_limit"
  | "not_found"
  | "permission"
  | "channel_not_found"
  | "transient"
  | "unknown";

const ERROR_CODE_MAP: Record<string, SlackErrorCategory> = {
  // Auth errors — token is invalid or revoked, do not retry
  invalid_auth: "auth",
  token_expired: "auth",
  token_revoked: "auth",
  not_authed: "auth",
  account_inactive: "auth",
  org_login_required: "auth",

  // Rate limit — retry after backoff
  rate_limited: "rate_limit",
  ratelimited: "rate_limit",

  // Channel-specific not-found errors
  channel_not_found: "channel_not_found",
  is_archived: "channel_not_found",

  // Permission errors — bot lacks required scopes or access
  not_in_channel: "permission",
  missing_scope: "permission",
  ekm_access_denied: "permission",
  not_allowed_token_type: "permission",
  restricted_action: "permission",
  cannot_dm_bot: "permission",

  // General not-found errors
  user_not_found: "not_found",
  message_not_found: "not_found",
  thread_not_found: "not_found",
};

/**
 * Classify a Slack error code into a semantic category.
 */
export function classifySlackError(
  errorCode: string | undefined,
): SlackErrorCategory {
  if (!errorCode) return "unknown";
  return ERROR_CODE_MAP[errorCode] ?? "unknown";
}

/**
 * Whether the error category indicates the request could succeed on retry.
 */
export function isRetryable(category: SlackErrorCategory): boolean {
  return (
    category === "rate_limit" ||
    category === "transient" ||
    category === "unknown"
  );
}
