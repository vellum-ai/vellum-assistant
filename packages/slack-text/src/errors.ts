/**
 * Shared Slack Web API error classification.
 *
 * Maps Slack error codes to semantic categories so callers — the assistant's
 * outbound client and the gateway — can decide whether to retry, surface a
 * user-facing message, or escalate. This is the single source of truth for the
 * code → category mapping; both packages import it instead of keeping copies
 * that drift (see the root AGENTS.md "Single Source of Truth" rule).
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

const SLACK_ERROR_CODE_MAP: Record<string, SlackErrorCategory> = {
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

  // Client-side errors — the Block Kit payload itself is invalid or too big,
  // retrying the same request will fail identically. `invalid_blocks` covers
  // malformed blocks and over-the-50-block-limit messages; `msg_blocks_too_long`
  // is Slack's code for cumulative block text over its ~13k ceiling.
  invalid_blocks: "client_error",
  msg_blocks_too_long: "client_error",
};

/**
 * Classify a Slack error code into a semantic category. Returns "unknown" for
 * unrecognized codes and for missing input.
 */
export function classifySlackError(
  errorCode: string | undefined,
): SlackErrorCategory {
  if (!errorCode) return "unknown";
  return SLACK_ERROR_CODE_MAP[errorCode] ?? "unknown";
}
