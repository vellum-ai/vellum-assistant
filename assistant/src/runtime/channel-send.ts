/**
 * A model-directed text send to a channel chat, through the channel's
 * transport, recorded after the channel acknowledges it.
 *
 * This is the one send implementation per addressable channel. The
 * messaging tool's channel branch and the `channels send` route both call
 * it, so a send costs the same and leaves the same record whichever door it
 * came through. The transport owns the routing: the caller names a neutral
 * target, the transport resolves it into its own callback context, and
 * nothing here switches on a channel's name.
 *
 * Nothing is written before the channel acknowledges. The record carries
 * every id the text became, so a failed send leaves no row that reads as
 * something the assistant said, and a reaction, edit, or delete naming any
 * chunk resolves to the row; the inbound binding a transport asks for is
 * written after the same acknowledgement, so a failed send does not move
 * where the chat's next message lands. A send into the sending turn's own
 * chat and thread writes no row: its tool call and result already sit in
 * that conversation's history, and a second assistant row beside the tool
 * pair would break history repair.
 */

import { type ChannelId, isChannelId } from "../channels/types.js";
import type {
  ProactiveAddress,
  ProactiveTarget,
} from "../messaging/providers/channel-transport.js";
import { getTransportForChannel } from "../messaging/providers/index.js";
import { resolveProactiveHomeConversation } from "../notifications/conversation-pairing.js";
import { recordDeliveredChannelPost } from "../notifications/delivered-post-record.js";
import { getConversation } from "../persistence/conversation-crud.js";
import { syncMessageToDisk } from "../persistence/conversation-disk-view.js";
import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { buildScopedConversationKey } from "../persistence/delivery-crud.js";
import {
  normalizeExternalThreadId,
  upsertOutboundBinding,
} from "../persistence/external-conversation-store.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { publishConversationListChanged } from "./sync/resource-sync-events.js";

const log = getLogger("channel-send");

/**
 * The turn a send is made from, as a snapshot taken when the turn started:
 * the channel it arrived on, the chat, and the thread. Read from the turn
 * rather than from the live binding, which a concurrent inbound can rewrite
 * while the send runs. A caller with no turn (a script) names only the
 * conversation it acts for, and the home comparison decides on its own.
 */
export interface ChannelSendSender {
  readonly conversationId: string;
  readonly executionChannel?: string;
  readonly requesterChatId?: string;
  readonly sourceThreadId?: string;
}

export interface ChannelSendParams {
  readonly channel: string;
  readonly target: ProactiveTarget;
  readonly text: string;
  /** Ask the channel for its rich rendering of the text, where it has one. */
  readonly renderRichly?: boolean;
  /** The assistant the send acts for; absent or `self` is this assistant. */
  readonly assistantId?: string;
  readonly sender?: ChannelSendSender;
}

export interface ChannelSendResult {
  readonly channel: ChannelId;
  /** The chat the post landed in, in the channel's own id space. */
  readonly chatId: string;
  /** The thread the post landed in, absent when it is not in one. */
  readonly threadId?: string;
  /** Every id the channel acknowledged for the text, in send order; never empty. */
  readonly messageIds: readonly string[];
  /** The id of the final post, the one a later edit or withdrawal addresses. */
  readonly lastMessageId: string;
  /** The conversation the post was recorded in, absent when it was not. */
  readonly recordedIn?: string;
}

/** The channel cannot be reached from a named target. */
export class ChannelNotAddressableError extends Error {
  constructor(
    readonly channel: string,
    reason: string,
  ) {
    super(`Channel "${channel}" ${reason}.`);
    this.name = "ChannelNotAddressableError";
  }
}

/**
 * The transport ran but the channel did not acknowledge the send. A success
 * that names no message id counts: an id is what makes the post addressable
 * afterwards, and without one there is nothing to record.
 */
export class ChannelSendFailedError extends Error {
  constructor(
    readonly channel: ChannelId,
    reason = "did not acknowledge the send",
  ) {
    super(`Channel "${channel}" ${reason}.`);
    this.name = "ChannelSendFailedError";
  }
}

/**
 * Whether a channel's transport declares it can be addressed from a named
 * chat or person. A channel with no transport, or one that only answers on
 * an inbound callback, is not.
 */
export function isProactivelyAddressable(channel: string): boolean {
  return getTransportForChannel(channel)?.addressFor !== undefined;
}

/**
 * Deliver `text` to `target` on `channel` and record what was sent.
 *
 * Throws {@link ChannelNotAddressableError} before any delivery when the
 * channel or the target shape cannot be addressed, and
 * {@link ChannelSendFailedError} when the transport reports no
 * acknowledgement or no message id. A binding or recording failure never
 * fails the send: the message is already out.
 */
export async function sendChannelText(
  params: ChannelSendParams,
): Promise<ChannelSendResult> {
  const { channel, target, text } = params;
  if (!isChannelId(channel)) {
    throw new ChannelNotAddressableError(channel, "is not a channel");
  }
  const transport = getTransportForChannel(channel);
  if (!transport?.addressFor) {
    throw new ChannelNotAddressableError(
      channel,
      "cannot be addressed from a named chat",
    );
  }
  const address = await transport.addressFor(target);
  if (!address) {
    throw new ChannelNotAddressableError(
      channel,
      `cannot be addressed by ${target.kind}`,
    );
  }

  const result = await transport.deliver(address.ctx, {
    chatId: address.chatId,
    text,
    ...(params.renderRichly ? { renderRichly: true } : {}),
    ...(params.assistantId ? { assistantId: params.assistantId } : {}),
  });
  if (!result.ok) {
    throw new ChannelSendFailedError(channel);
  }
  const messageIds = result.messageIds ?? (result.ts ? [result.ts] : []);
  const lastMessageId = result.ts ?? messageIds[messageIds.length - 1];
  if (!lastMessageId) {
    throw new ChannelSendFailedError(channel, "acknowledged no message id");
  }

  const actsForSelf =
    !params.assistantId || params.assistantId === DAEMON_INTERNAL_ASSISTANT_ID;
  if (transport.bindsChatOnProactiveSend && actsForSelf) {
    bindChatForNextInbound(channel, address);
  }

  const recordedIn = await recordProactivePost({
    channel,
    address,
    text,
    messageIds,
    sender: params.sender,
  });

  return {
    channel,
    chatId: address.chatId,
    ...(address.threadId ? { threadId: address.threadId } : {}),
    messageIds,
    lastMessageId,
    ...(recordedIn ? { recordedIn } : {}),
  };
}

/**
 * Bind the chat's inbound conversation to the delivered chat and thread, so
 * the next message from there resolves to the conversation ingress uses for
 * it. The key is the one ingress builds, thread-scoped where the channel
 * scopes conversations by thread, so a topic's replies continue the topic's
 * conversation. Runs after acknowledgement: the message is out, so the
 * binding it asks for is owed. Best effort: a binding failure must not fail
 * the send.
 */
function bindChatForNextInbound(
  channel: ChannelId,
  address: ProactiveAddress,
): void {
  try {
    const { conversationId, created } = getOrCreateConversation(
      buildScopedConversationKey(channel, address.chatId, address.threadId),
    );
    // Published before the binding, not after: the conversation exists as
    // soon as it is minted, the record that follows finds it rather than
    // minting it, and a binding that throws must not leave a conversation
    // holding a real message out of the list.
    if (created) {
      publishConversationListChanged("created");
    }
    upsertOutboundBinding({
      conversationId,
      sourceChannel: channel,
      externalChatId: address.chatId,
      externalThreadId: address.threadId ?? null,
    });
  } catch (e) {
    log.warn(
      {
        err: e,
        channel,
        externalChatId: address.chatId,
        externalThreadId: address.threadId,
      },
      "Failed to bind the chat's inbound conversation after the send",
    );
  }
}

/**
 * Record the acknowledged post where the chat's proactive posts live, so
 * the chat's own conversation and `recall` can see what was sent from
 * elsewhere. The row names the thread the post landed in, as the transport
 * resolved it. Returns the conversation it was recorded in, or `undefined`
 * when nothing was recorded: the send went into the sending turn's own chat
 * and thread, or the home is the sender.
 */
async function recordProactivePost(params: {
  channel: ChannelId;
  address: ProactiveAddress;
  text: string;
  messageIds: readonly string[];
  sender: ChannelSendSender | undefined;
}): Promise<string | undefined> {
  const { channel, address, sender } = params;
  const [firstId, ...restIds] = params.messageIds;
  if (!firstId) {
    return undefined;
  }
  try {
    if (
      sender &&
      isSendIntoOwnChat(sender, channel, address.chatId, address.threadId)
    ) {
      return undefined;
    }
    const home = await resolveProactiveHomeConversation({
      sourceChannel: channel,
      externalChatId: address.chatId,
      threadId: address.threadId,
      source: "notification",
      conversationType: "background",
      title: `Messages to ${address.chatId}`,
    });
    if (home.conversationId === sender?.conversationId) {
      return undefined;
    }
    const recorded = await recordDeliveredChannelPost({
      conversationId: home.conversationId,
      channel,
      externalChatId: address.chatId,
      ...(address.threadId ? { threadId: address.threadId } : {}),
      text: params.text,
      providerMessageId: firstId,
      ...(restIds.length > 0 ? { additionalProviderMessageIds: restIds } : {}),
      ...(sender ? { crossPostedFrom: sender.conversationId } : {}),
    });
    const homeConversation = getConversation(home.conversationId);
    if (homeConversation) {
      syncMessageToDisk(
        home.conversationId,
        recorded.messageId,
        homeConversation.createdAt,
      );
    }
    return home.conversationId;
  } catch (e) {
    log.warn(
      { err: e, channel, externalChatId: address.chatId },
      "Failed to record the sent message in the chat's conversation",
    );
    return undefined;
  }
}

/**
 * True when the delivered chat and thread are the ones the sending turn
 * arrived in. Thread ids compare in the binding store's normalized form, so
 * an absent thread on both sides matches and a thread-less delivery never
 * matches a turn that arrived in a thread.
 */
function isSendIntoOwnChat(
  sender: ChannelSendSender,
  channel: ChannelId,
  chatId: string,
  deliveredThreadId: string | undefined,
): boolean {
  if (!sender.executionChannel || !sender.requesterChatId) {
    return false;
  }
  return (
    sender.executionChannel === channel &&
    sender.requesterChatId === chatId &&
    normalizeExternalThreadId(sender.sourceThreadId) ===
      normalizeExternalThreadId(deliveredThreadId)
  );
}
