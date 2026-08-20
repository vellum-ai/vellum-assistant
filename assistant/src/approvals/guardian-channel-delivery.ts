import { isSlackDmChatId } from "../messaging/providers/slack/conversation-utils.js";

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
 * Strip the `threadTs` query param from a reply callback URL.
 *
 * The param addresses a thread in the channel the turn arrived on. Carried
 * onto a delivery aimed somewhere else, it asks the transport to attach the
 * message to a thread that does not exist there, which Slack rejects as
 * `thread_not_found`. Relative or malformed URLs are returned as-is.
 */
export function stripThreadTsParam(replyCallbackUrl: string): string {
  try {
    const url = new URL(replyCallbackUrl);
    url.searchParams.delete("threadTs");
    return url.toString();
  } catch {
    return replyCallbackUrl;
  }
}

/**
 * Resolve where a guardian's own approval prompt is delivered, or `null` when
 * it cannot be delivered privately at all.
 *
 * The prompt is raised by a turn the guardian is having, and on Slack that
 * turn can be running in a shared room. The card carries the tool name, a
 * command preview and live Approve/Reject buttons, so posting it there shows
 * all three to everyone in the room and lets any of them decide.
 *
 * It is addressed to the guardian's bound DM, the same value and the same
 * `isSlackDmChatId` gate the notification pipeline's Slack destination uses,
 * and for the same reason: a binding created from an `app_mention` names a
 * shared channel, so a bound chat is not private by construction.
 *
 * A DM chat id rather than the guardian's user id, though posting to a user id
 * would also open the DM, because this address is recorded on the delivery row
 * and read back three times: to match an emoji reaction to its request, to
 * scope which requests a plain-text reply may decide, and to edit the card
 * once it is decided. Those readers compare against the DM channel the
 * guardian's replies arrive on, which a `U…` id never equals.
 *
 * Returns `null` rather than falling back to the room, because the room is the
 * disclosure this exists to prevent. The caller delivers nothing and the
 * prompt remains answerable in the app.
 */
export function resolveGuardianPromptDelivery(params: {
  channel: string;
  turnChatId: string;
  turnCallbackUrl: string;
  guardianChatId: string | undefined;
}): { chatId: string; callbackUrl: string } | null {
  const { channel, turnChatId, turnCallbackUrl, guardianChatId } = params;
  const inTurn = { chatId: turnChatId, callbackUrl: turnCallbackUrl };

  // Only Slack has a chat whose privacy can be read off the id. A Telegram
  // group chat carries the same exposure and is not covered here.
  if (channel !== "slack") {
    return inTurn;
  }
  if (isSlackDmChatId(turnChatId)) {
    return inTurn;
  }
  if (!guardianChatId || !isSlackDmChatId(guardianChatId)) {
    return null;
  }
  return {
    chatId: guardianChatId,
    callbackUrl: stripThreadTsParam(turnCallbackUrl),
  };
}
