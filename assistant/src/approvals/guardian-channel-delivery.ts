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
 *
 * Discord carries `dm=1`, which tells its transport that the `chatId` it is
 * handed names a person to open a DM with rather than a channel to post in.
 * Pair it with {@link resolveRequesterDeliveryTarget}, which supplies that
 * person.
 */
export function resolveDeliverCallbackUrlForChannel(
  channel: string,
): string | null {
  switch (channel) {
    case "telegram":
    case "whatsapp":
    case "slack":
      return `/deliver/${channel}`;
    case "discord":
      return "/deliver/discord?dm=1";
    default:
      return null;
  }
}

/**
 * Resolve who a requester notice is addressed to on the callback-less route.
 *
 * A request's `requesterChatId` is wherever the request came from, and on
 * Slack and Discord that is a room other people can read. "Your request was
 * denied" posted into a community channel is worse than not sending it, so
 * both address the requester's own user id instead and let their transport
 * turn it into a DM.
 *
 * Telegram and WhatsApp fall through to the chat id because theirs already is
 * the private one-to-one conversation.
 */
export function resolveRequesterDeliveryTarget(params: {
  channel: string;
  requesterChatId: string;
  requesterExternalUserId: string;
}): string {
  const { channel, requesterChatId, requesterExternalUserId } = params;
  if (
    (channel === "slack" || channel === "discord") &&
    requesterExternalUserId
  ) {
    return requesterExternalUserId;
  }
  return requesterChatId;
}
