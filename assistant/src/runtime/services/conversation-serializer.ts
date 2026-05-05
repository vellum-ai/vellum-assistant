/**
 * Standalone helpers for serializing conversation summaries and detail
 * responses.
 *
 * Extracted from RuntimeHttpServer so that route handlers (e.g.
 * conversation-analysis-routes) can build detail responses without
 * depending on the server class.
 */

import { parseChannelId } from "../../channels/types.js";
import { normalizeConversationType } from "../../daemon/message-types/shared.js";
import {
  type AttentionState,
  type Confidence,
  getAttentionStateByConversationIds,
  type SignalType,
} from "../../memory/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getDisplayMetaForConversations,
} from "../../memory/conversation-crud.js";
import type { ExternalConversationBinding } from "../../memory/external-conversation-store.js";
import { getBindingsForConversations } from "../../memory/external-conversation-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAssistantAttention(attentionState: AttentionState | undefined):
  | {
      hasUnseenLatestAssistantMessage: boolean;
      latestAssistantMessageAt?: number;
      lastSeenAssistantMessageAt?: number;
      lastSeenConfidence?: Confidence;
      lastSeenSignalType?: SignalType;
    }
  | undefined {
  if (!attentionState) return undefined;

  return {
    hasUnseenLatestAssistantMessage:
      attentionState.latestAssistantMessageAt != null &&
      (attentionState.lastSeenAssistantMessageAt == null ||
        attentionState.lastSeenAssistantMessageAt <
          attentionState.latestAssistantMessageAt),
    ...(attentionState.latestAssistantMessageAt != null
      ? {
          latestAssistantMessageAt: attentionState.latestAssistantMessageAt,
        }
      : {}),
    ...(attentionState.lastSeenAssistantMessageAt != null
      ? {
          lastSeenAssistantMessageAt: attentionState.lastSeenAssistantMessageAt,
        }
      : {}),
    ...(attentionState.lastSeenConfidence != null
      ? { lastSeenConfidence: attentionState.lastSeenConfidence }
      : {}),
    ...(attentionState.lastSeenSignalType != null
      ? { lastSeenSignalType: attentionState.lastSeenSignalType }
      : {}),
  };
}

function buildForkParent(
  conversation: ConversationRow,
  parentCache: Map<string, ConversationRow | null>,
): { conversationId: string; messageId: string; title: string } | undefined {
  const parentConversationId = conversation.forkParentConversationId;
  const parentMessageId = conversation.forkParentMessageId;
  if (!parentConversationId || !parentMessageId) return undefined;

  let parentConversation: ConversationRow | null | undefined =
    parentCache.get(parentConversationId);
  if (parentConversation === undefined) {
    parentConversation = getConversation(parentConversationId);
    parentCache.set(parentConversationId, parentConversation);
  }
  if (!parentConversation) {
    return undefined;
  }

  return {
    conversationId: parentConversationId,
    messageId: parentMessageId,
    title: parentConversation.title ?? "Untitled",
  };
}

export function serializeConversationSummary(params: {
  conversation: ConversationRow;
  binding?: ExternalConversationBinding | null;
  attentionState?: AttentionState;
  displayMeta?: {
    displayOrder: number | null;
    isPinned: boolean;
    groupId: string | null;
  };
  parentCache: Map<string, ConversationRow | null>;
}) {
  const { conversation, binding, attentionState, displayMeta, parentCache } =
    params;
  const originChannel = parseChannelId(conversation.originChannel);
  const assistantAttention = buildAssistantAttention(attentionState);
  const forkParent = buildForkParent(conversation, parentCache);

  return {
    id: conversation.id,
    title: conversation.title ?? "Untitled",
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    conversationType: normalizeConversationType(conversation.conversationType),
    source: conversation.source ?? "user",
    ...(conversation.scheduleJobId
      ? { scheduleJobId: conversation.scheduleJobId }
      : {}),
    ...(binding
      ? {
          channelBinding: {
            sourceChannel: binding.sourceChannel,
            externalChatId: binding.externalChatId,
            externalUserId: binding.externalUserId,
            displayName: binding.displayName,
            username: binding.username,
          },
        }
      : {}),
    ...(originChannel ? { conversationOriginChannel: originChannel } : {}),
    ...(assistantAttention ? { assistantAttention } : {}),
    ...(displayMeta?.isPinned
      ? {
          isPinned: true as const,
          displayOrder: displayMeta.displayOrder,
        }
      : displayMeta?.displayOrder != null
        ? {
            displayOrder: displayMeta.displayOrder,
          }
        : {}),
    groupId: displayMeta?.groupId ?? null,
    ...(forkParent ? { forkParent } : {}),
    ...(conversation.archivedAt != null
      ? { archivedAt: conversation.archivedAt }
      : {}),
    ...(conversation.inferenceProfile != null
      ? { inferenceProfile: conversation.inferenceProfile }
      : {}),
  };
}

/**
 * Build a full conversation detail response from a conversation ID.
 * Returns null if the conversation doesn't exist.
 */
export function buildConversationDetailResponse(
  conversationId: string,
): { conversation: ReturnType<typeof serializeConversationSummary> } | null {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return null;
  }

  const bindings = getBindingsForConversations([conversation.id]);
  const attentionStates = getAttentionStateByConversationIds([conversation.id]);
  const displayMeta = getDisplayMetaForConversations([conversation.id]);
  const parentCache = new Map<string, ConversationRow | null>();

  return {
    conversation: serializeConversationSummary({
      conversation,
      binding: bindings.get(conversation.id),
      attentionState: attentionStates.get(conversation.id),
      displayMeta: displayMeta.get(conversation.id),
      parentCache,
    }),
  };
}
