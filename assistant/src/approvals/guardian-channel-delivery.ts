/**
 * Shared addressing helpers for guardian-flow channel notices.
 *
 * Requester notices (approval, denial, expiry) and the guardian's own approval
 * prompt are delivered straight to a chat via `deliverChannelReply` -
 * independent of the guardian-facing notification pipeline. Centralizing the
 * addressing rules here keeps the decision resolvers, the timer-driven expiry
 * sweep and the in-turn approval prompt from drifting apart on who a message
 * is put in front of.
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
 * Whether a notice can be addressed to one person by their user id rather than
 * to the conversation the request arrived in.
 *
 * Slack opens a 1:1 DM when a `U…` id is posted as the channel. Discord
 * resolves a user snowflake to a DM channel on its `dm`-marked route. This is
 * an OUTBOUND question only: it says a message can be put in front of one
 * person, and nothing about whether they can answer it.
 */
export function channelDeliversToUserId(channel: string): boolean {
  return channel === "slack" || channel === "discord";
}

/**
 * Whether a verification code can be sent straight to the requester, rather
 * than handed to the guardian to relay out of band.
 *
 * Deliberately NOT the same set as {@link channelDeliversToUserId}, though it
 * looks like it. That one asks whether a message reaches one person; this asks
 * whether a code handshake can COMPLETE there, which additionally needs the
 * reply to be heard. The copy this gates says "reply with it here", so a
 * channel that can send into a DM but not receive from one would strand the
 * requester holding a code they can never spend.
 *
 * Discord qualifies on both halves: its `dm`-marked route reaches the person,
 * and `gateway/src/discord/admit.ts` admits DMs so the reply is heard.
 */
export function channelCanCompleteCodeHandshakeInDm(channel: string): boolean {
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
  if (channelDeliversToUserId(channel) && requesterExternalUserId) {
    return requesterExternalUserId;
  }
  return requesterChatId;
}

/**
 * Reduce a reply callback to its channel route, dropping every query param.
 *
 * A callback addresses the turn it came from. The gateway hangs the turn's
 * coordinates on it as params, and each transport reads a different one:
 * Slack a `threadTs`, Telegram a forum topic `threadId`, Discord a `threadId`
 * that replaces the destination outright rather than narrowing it. Carried
 * onto a delivery aimed elsewhere they either fail the send or quietly win
 * over the new address, and a redirect that leaves one behind is
 * indistinguishable from no redirect at all.
 *
 * Everything is dropped rather than a named set, so a channel added later, or
 * a param a transport starts reading later, cannot silently escape this. The
 * channel itself survives because it is the path, which is also what
 * `isDirectDelivery` resolves a transport from, and nothing the gateway hangs
 * on a deliver callback is needed to authorize or route the send.
 *
 * Relative or malformed URLs are returned as-is; they carry no params.
 */
export function stripTurnDestination(replyCallbackUrl: string): string {
  try {
    const url = new URL(replyCallbackUrl);
    url.search = "";
    return url.toString();
  } catch {
    return replyCallbackUrl;
  }
}

/**
 * Resolve where a guardian's own approval prompt is delivered.
 *
 * The prompt is raised by a turn the guardian is having, and that turn can be
 * running in a room: a shared Slack channel, a Telegram group. The card
 * carries the tool name and a preview of the command, so delivering it where
 * the turn is shows both to everyone there.
 *
 * It goes to the guardian's own bound chat instead, the address they
 * nominated when they verified and the one the notification pipeline already
 * sends guardian cards to. No channel is named in this rule and none can be
 * forgotten by it: a bound chat is the guardian's by definition, on any
 * channel, including ones not built yet.
 *
 * A bound chat equal to the turn's chat means the turn is already there, so
 * nothing moves. That also covers a turn where no binding resolved, since the
 * trust context falls back to the turn's own chat, leaving delivery exactly as
 * it is rather than dropping it.
 */
export function resolveGuardianPromptDelivery(params: {
  turnChatId: string;
  turnCallbackUrl: string;
  guardianChatId: string | undefined;
}): { chatId: string; callbackUrl: string } {
  const { turnChatId, turnCallbackUrl, guardianChatId } = params;
  if (!guardianChatId || guardianChatId === turnChatId) {
    return { chatId: turnChatId, callbackUrl: turnCallbackUrl };
  }
  return {
    chatId: guardianChatId,
    callbackUrl: stripTurnDestination(turnCallbackUrl),
  };
}
