/**
 * Shared addressing helpers for guardian requester-facing channel notices.
 *
 * Requester notices (approval, denial, expiry) are delivered straight to the
 * requester's chat via `deliverChannelReply` — independent of the
 * guardian-facing notification pipeline. Centralizing the addressing rules here
 * keeps the decision resolvers and the timer-driven expiry sweep from drifting
 * apart on how a requester is reached.
 */

/**
 * Resolve the callback-less delivery route for a channel (e.g. `/deliver/slack`).
 *
 * Used when there is no inbound reply callback URL to post back to — the
 * guardian decided off-channel (desktop), or the expiry sweep fired on a timer
 * with no originating request in hand. Returns null for channels that have no
 * deliverable route (e.g. email, the in-app vellum surface).
 */
export function resolveDeliverCallbackUrlForChannel(
  channel: string,
): string | null {
  switch (channel) {
    case "telegram":
    case "whatsapp":
    case "slack":
      return `/deliver/${channel}`;
    default:
      return null;
  }
}
