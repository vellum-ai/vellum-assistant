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
  | "client_error"
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

  // Client-side errors — the payload itself is invalid, retrying the same
  // request will fail identically. Callers that inspect the category should
  // treat these as permanent failures and not re-send the same payload.
  invalid_blocks: "client_error",
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
 * `client_error` is explicitly non-retryable: the payload itself is the
 * problem, so re-sending it would fail identically.
 */
export function isRetryable(category: SlackErrorCategory): boolean {
  return (
    category === "rate_limit" ||
    category === "transient" ||
    category === "unknown"
  );
}

/**
 * User-friendly error messages by category.
 * These are actionable: they tell the user what to do to fix the problem.
 */
const CATEGORY_USER_MESSAGES: Record<SlackErrorCategory, string | undefined> = {
  auth: "My Slack connection has expired. Please re-configure the Slack integration.",
  channel_not_found:
    "I can't find this channel. It may have been deleted or I may need to be re-added.",
  permission:
    "I don't have the required permissions for this channel. Please check my access.",
  not_found: "The requested resource could not be found in Slack.",
  rate_limit: "Slack rate limit reached. Please try again in a moment.",
  client_error:
    "I couldn't format that message for Slack. Please try again.",
  transient: undefined,
  unknown: undefined,
};

/**
 * More specific user messages for individual Slack error codes, overriding
 * the category-level default when a more actionable message is available.
 */
const ERROR_CODE_USER_MESSAGES: Record<string, string> = {
  channel_not_found:
    "I can't send messages to this channel. Please re-add me to the channel.",
  is_archived:
    "This channel has been archived. Please unarchive it or use a different channel.",
  not_in_channel:
    "I need to be invited to this channel first. Please add me to the channel.",
  missing_scope:
    "I don't have the required permissions. Please re-install the Slack app with the necessary scopes.",
  cannot_dm_bot: "I can't send direct messages to other bots.",
  token_revoked:
    "My Slack connection has expired. Please re-configure the Slack integration.",
  token_expired:
    "My Slack connection has expired. Please re-configure the Slack integration.",
  invalid_auth:
    "My Slack connection has expired. Please re-configure the Slack integration.",
};

/**
 * Return a user-friendly, actionable error message for a Slack error.
 * Prefers a code-specific message, then falls back to the category default.
 * Returns `undefined` for transient/unknown errors that have no useful user guidance.
 */
export function getUserMessage(
  errorCode: string | undefined,
): string | undefined {
  if (errorCode && ERROR_CODE_USER_MESSAGES[errorCode]) {
    return ERROR_CODE_USER_MESSAGES[errorCode];
  }
  const category = classifySlackError(errorCode);
  return CATEGORY_USER_MESSAGES[category];
}
