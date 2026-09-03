/**
 * Record a post the daemon delivered to an external chat as a first-class
 * assistant row.
 *
 * The row carries the text the channel received, the neutral provider
 * envelope every channel row writes, and `automated: true` so memory
 * extraction leaves it alone while lexical search indexes it. The shared
 * post-send reconciliation then stamps the acknowledged provider id on the
 * envelope and in `channel_outbound_posts`, the same writer a conversation
 * reply uses, so a later reaction, edit, or delete naming the post resolves
 * to this row.
 *
 * Called only after a channel adapter reported success with a provider
 * message id. Nothing here runs for a failed or pending delivery, so a post
 * the channel never accepted can never read as something the assistant said.
 */

import type { ChannelId } from "../channels/types.js";
import { findConversation } from "../daemon/conversation-registry.js";
import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import type { ProviderMessageMetadata } from "../messaging/provider-message-metadata.js";
import {
  addMessage,
  provenanceFromTrustContext,
} from "../persistence/conversation-crud.js";
import { makeSentMessageIdReconciler } from "../runtime/outbound-post-reconciliation.js";
import { publishConversationMessagesChanged } from "../runtime/sync/resource-sync-events.js";

export interface DeliveredChannelPost {
  /** Conversation the chat's proactive posts live in. */
  conversationId: string;
  /** Channel the post went out on; the envelope's `source`. */
  channel: ChannelId;
  /** Channel-native id of the chat the post landed in. */
  externalChatId: string;
  /** The text the adapter sent, as the channel received it. */
  text: string;
  /** The message id the channel assigned when it acknowledged the post. */
  providerMessageId: string;
  /**
   * The conversation whose turn made the post, when a different one from
   * the home it is recorded in (the messaging tool sending from a scheduled
   * run, for instance). Stamped as `crossPostedFrom` so the row says where
   * it came from.
   */
  crossPostedFrom?: string;
}

/**
 * Persist the delivered post and reconcile its acknowledged id. Returns the
 * canonical row id for the delivery audit to reference.
 */
export async function recordDeliveredChannelPost(
  post: DeliveredChannelPost,
): Promise<{ messageId: string }> {
  const envelope: ProviderMessageMetadata = {
    source: post.channel,
    conversationExternalId: post.externalChatId,
    eventKind: "message",
  };
  const row = await addMessage(post.conversationId, "assistant", post.text, {
    metadata: {
      // The pipeline acts for the assistant itself; the same trust the
      // producer ran under.
      ...provenanceFromTrustContext(INTERNAL_GUARDIAN_TRUST_CONTEXT),
      assistantMessageChannel: post.channel,
      sentAt: Date.now(),
      automated: true,
      providerMeta: JSON.stringify(envelope),
      ...(post.crossPostedFrom
        ? { crossPostedFrom: post.crossPostedFrom }
        : {}),
    },
  });
  await makeSentMessageIdReconciler(row.id)(post.providerMessageId);
  // A resident conversation reloads its history on the next turn so the
  // post is in context; the client refetches the transcript.
  findConversation(post.conversationId)?.markHistoryStale();
  publishConversationMessagesChanged(post.conversationId);
  return { messageId: row.id };
}
