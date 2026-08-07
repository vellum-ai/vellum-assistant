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
 * Whether a message posted back in-band on this channel can be kept to one
 * reader.
 *
 * Slack can, with `chat.postEphemeral`. Discord cannot: it has no ephemeral
 * message outside an interaction response, so anything posted into the room a
 * guardian replied in, or the room a request came from, is readable by every
 * member of the server. That applies to a decision notice and to a
 * verification code alike, which is why the callers treat an in-band reply
 * context as unusable for Discord and fall through to the DM route instead.
 *
 * Telegram and WhatsApp are trivially true: their conversation already has one
 * reader.
 */
export function channelCanAddressOneReaderInBand(channel: string): boolean {
  return channel !== "discord";
}

/**
 * Whether the channel can reach a requester privately by addressing their user
 * id, so a verification code can go straight to them instead of the guardian
 * relaying it out of band.
 *
 * Slack opens a 1:1 DM when a `U…` id is posted as the channel. Discord
 * resolves a user snowflake to a DM channel on its `dm`-marked route. No other
 * channel has a guaranteed private path to a user id, so elsewhere the code
 * stays with the guardian and the requester gets a courier notice.
 */
export function channelHasPrivateRequesterRoute(channel: string): boolean {
  return channel === "slack" || channel === "discord";
}

/**
 * Resolve who a requester notice is addressed to on the callback-less route.
 *
 * A request's `requesterChatId` is wherever the request came from, and where
 * the channel has a private route to a user id that room is one other people
 * can read. "Your request was denied" posted into a community channel is worse
 * than not sending it, so those channels address the requester's own user id
 * instead and let their transport turn it into a DM.
 *
 * Telegram and WhatsApp fall through to the chat id because theirs already is
 * the private one-to-one conversation. So does a request with no actor
 * identity: there is nobody to open a DM with, and on the channels that need
 * one the transport reports that as a delivery failure rather than posting to
 * the room.
 */
export function resolveRequesterDeliveryTarget(params: {
  channel: string;
  requesterChatId: string;
  requesterExternalUserId: string;
}): string {
  const { channel, requesterChatId, requesterExternalUserId } = params;
  if (channelHasPrivateRequesterRoute(channel) && requesterExternalUserId) {
    return requesterExternalUserId;
  }
  return requesterChatId;
}
