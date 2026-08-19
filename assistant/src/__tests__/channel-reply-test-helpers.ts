/**
 * Helpers for suites that capture outbound channel replies.
 *
 * A captured payload is typed `Record<string, unknown>` rather than
 * `ChannelReplyPayload`, so reaching a channel's own options needs a cast that
 * is easy to spell differently in each suite.
 */

/** The Slack options off a captured wire payload. */
export function slackExtrasOf(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return payload.slack as Record<string, unknown> | undefined;
}
