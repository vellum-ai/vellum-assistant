/**
 * Slack error handling for the gateway: retry decisions and user-facing
 * messages. The Slack error-code → category classification is shared with the
 * assistant via `@vellumai/slack-text/errors` (single source of truth — see the
 * root AGENTS.md); this module layers the gateway's retry and messaging policy
 * on top and re-exports the shared classifier so existing importers stay
 * unaffected.
 */

import { classifySlackError } from "@vellumai/slack-text/errors";
import type { SlackErrorCategory } from "@vellumai/slack-text/errors";

export { classifySlackError };

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
  client_error: "I couldn't format that message for Slack. Please try again.",
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
