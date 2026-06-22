/**
 * Standalone helpers for serializing conversation summaries and detail
 * responses.
 *
 * Extracted from RuntimeHttpServer so that route handlers (e.g.
 * conversation-analysis-routes) can build detail responses without
 * depending on the server class.
 */

import { parseChannelId } from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import { findConversation } from "../../daemon/conversation-registry.js";
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
import {
  buildSlackMessageDeepLinks,
  buildSlackWebChannelUrl,
} from "../../messaging/providers/slack/deep-link.js";

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

/**
 * Resolve the wire-level `groupId` for a conversation summary.
 *
 * Surfaced conversations (`surfaced_at IS NOT NULL`) render in the Recents
 * grouping on every client, but legacy clients (the macOS Swift app) bucket
 * purely by `groupId` and do not decode `surfacedAt`. Normalize the
 * *serialized* `groupId` to `"system:all"` for surfaced rows so those
 * clients render them in Recents without code changes — the persisted
 * `group_id` is untouched, so clearing `surfaced_at` (demotion) makes
 * serialization return the original group again.
 *
 * Mirrors web's `getEffectiveGroupId` precedence: an explicit pin
 * (`system:pinned`) or a user-created custom group wins over surfacing, so
 * only the system Background/Scheduled groups (and the null fallback, which
 * legacy clients re-derive into those buckets from `source`) are rewritten.
 */
function resolveSerializedGroupId(
  conversation: ConversationRow,
  persistedGroupId: string | null,
): string | null {
  if (conversation.surfacedAt == null) return persistedGroupId;
  if (
    persistedGroupId == null ||
    persistedGroupId === "system:background" ||
    persistedGroupId === "system:scheduled"
  ) {
    return "system:all";
  }
  return persistedGroupId;
}

function buildChannelBinding(binding: ExternalConversationBinding) {
  const externalChatName =
    binding.externalChatName?.trim() ||
    (binding.sourceChannel === "slack" ? binding.externalChatId : undefined);
  const slackConfig =
    binding.sourceChannel === "slack" ? getConfig().slack : undefined;
  const slackThreadLink =
    slackConfig && binding.externalThreadId
      ? buildSlackMessageDeepLinks({
          teamId: slackConfig.teamId,
          teamUrl: slackConfig.teamUrl,
          channelId: binding.externalChatId,
          messageTs: binding.externalThreadId,
        })
      : undefined;
  const slackThread =
    binding.sourceChannel === "slack" && binding.externalThreadId
      ? {
          channelId: binding.externalChatId,
          threadTs: binding.externalThreadId,
          ...(slackThreadLink ? { link: slackThreadLink } : {}),
        }
      : undefined;
  const slackChannelWebUrl = slackConfig
    ? buildSlackWebChannelUrl({
        teamUrl: slackConfig.teamUrl,
        channelId: binding.externalChatId,
      })
    : undefined;
  const slackChannel =
    binding.sourceChannel === "slack"
      ? {
          channelId: binding.externalChatId,
          name: externalChatName,
          ...(slackChannelWebUrl
            ? {
                link: {
                  webUrl: slackChannelWebUrl,
                },
              }
            : {}),
        }
      : undefined;

  return {
    sourceChannel: binding.sourceChannel,
    externalChatId: binding.externalChatId,
    ...(externalChatName ? { externalChatName } : {}),
    ...(binding.externalThreadId
      ? { externalThreadId: binding.externalThreadId }
      : {}),
    externalUserId: binding.externalUserId,
    displayName: binding.displayName,
    username: binding.username,
    ...(slackThread ? { slackThread } : {}),
    ...(slackChannel ? { slackChannel } : {}),
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
  /**
   * Whether the agent loop is currently mid-turn for this conversation.
   * Sourced from the in-memory daemon `Conversation.isProcessing()` flag
   * — callers resolve via `findConversation(id)?.isProcessing() ?? false`
   * so cold (evicted / never-loaded) rows report `false`. Plumbed in
   * rather than read here so the serializer stays a pure shape mapper
   * with no daemon-store coupling.
   */
  isProcessing: boolean;
}) {
  const {
    conversation,
    binding,
    attentionState,
    displayMeta,
    parentCache,
    isProcessing,
  } = params;
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
          channelBinding: buildChannelBinding(binding),
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
    groupId: resolveSerializedGroupId(
      conversation,
      displayMeta?.groupId ?? null,
    ),
    ...(forkParent ? { forkParent } : {}),
    ...(conversation.archivedAt != null
      ? { archivedAt: conversation.archivedAt }
      : {}),
    ...(conversation.surfacedAt != null
      ? { surfacedAt: conversation.surfacedAt }
      : {}),
    ...(conversation.inferenceProfile != null
      ? { inferenceProfile: conversation.inferenceProfile }
      : {}),
    isProcessing,
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
      // Cold (evicted / never-loaded) rows aren't in the in-memory
      // store, so `findConversation` returns `undefined` and they
      // report `isProcessing: false` — by definition they aren't
      // mid-turn since the agent loop only runs on resident convs.
      isProcessing: findConversation(conversation.id)?.isProcessing() ?? false,
    }),
  };
}
