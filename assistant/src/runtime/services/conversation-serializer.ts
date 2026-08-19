/**
 * Standalone helpers for serializing conversation summaries and detail
 * responses.
 *
 * Extracted from RuntimeHttpServer so that route handlers can build
 * detail responses without depending on the server class.
 */

import { parseChannelId } from "../../channels/types.js";
import { normalizeConversationType } from "../../daemon/message-types/shared.js";
import { buildChannelBindingMetadata } from "../../messaging/channel-binding-metadata.js";
import {
  type AttentionState,
  type Confidence,
  getAttentionStateByConversationIds,
  hasUnseenLatestAssistantMessage,
  type SignalType,
} from "../../persistence/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getDisplayMetaForConversations,
  isConversationProcessing,
} from "../../persistence/conversation-crud.js";
import { isReferentialFork } from "../../persistence/conversation-lineage.js";
import type { ExternalConversationBinding } from "../../persistence/external-conversation-store.js";
import { getBindingsForConversations } from "../../persistence/external-conversation-store.js";

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
  if (!attentionState) {
    return undefined;
  }

  return {
    hasUnseenLatestAssistantMessage:
      hasUnseenLatestAssistantMessage(attentionState),
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

interface ForkLineage {
  forkParent?: { conversationId: string; messageId: string; title: string };
  /**
   * The fork reads its history from a parent that is gone. Only meaningful for
   * referential forks: a cloning fork holds its own copy, so a deleted parent
   * costs it nothing and is not worth telling the user about.
   */
  historyOrphaned?: true;
}

function buildForkLineage(
  conversation: ConversationRow,
  parentCache: Map<string, ConversationRow | null>,
): ForkLineage {
  const parentConversationId = conversation.forkParentConversationId;
  const parentMessageId = conversation.forkParentMessageId;
  if (!parentConversationId || !parentMessageId) {
    return {};
  }

  let parentConversation: ConversationRow | null | undefined =
    parentCache.get(parentConversationId);
  if (parentConversation === undefined) {
    parentConversation = getConversation(parentConversationId);
    parentCache.set(parentConversationId, parentConversation);
  }
  if (!parentConversation) {
    // The parent lookup already happened, so reporting the orphan costs
    // nothing beyond the branch.
    return isReferentialFork(conversation) ? { historyOrphaned: true } : {};
  }

  return {
    forkParent: {
      conversationId: parentConversationId,
      messageId: parentMessageId,
      title: parentConversation.title ?? "Untitled",
    },
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
  if (conversation.surfacedAt == null) {
    return persistedGroupId;
  }
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
  const externalChatName = binding.externalChatName?.trim() || undefined;

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
    // Channel-specific enrichment (e.g. Slack deep links) is contributed by
    // the source channel's binding-metadata builder, keeping this serializer
    // channel-agnostic.
    ...buildChannelBindingMetadata(binding),
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
   * Resolved by `isConversationProcessing(id)`, which checks the in-memory
   * daemon flag first and falls back to the persisted
   * `processing_started_at` column for cold conversations. Plumbed in
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
  const forkLineage = buildForkLineage(conversation, parentCache);

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
    ...forkLineage,
    ...(conversation.archivedAt != null
      ? { archivedAt: conversation.archivedAt }
      : {}),
    ...(conversation.surfacedAt != null
      ? { surfacedAt: conversation.surfacedAt }
      : {}),
    ...(conversation.inferenceProfile != null
      ? { inferenceProfile: conversation.inferenceProfile }
      : {}),
    // Include when non-null so an explicit `[]` (user cleared all plugins) is
    // preserved; `null`/default is omitted.
    ...(conversation.enabledPlugins != null
      ? { enabledPlugins: conversation.enabledPlugins }
      : {}),
    isProcessing,
  };
}

/**
 * Serialize several conversations in one pass, for the writes that answer
 * with the rows they changed.
 *
 * The batched form of {@link buildConversationDetailResponse}: the three
 * per-row lookups (bindings, attention state, display meta) are issued once
 * for the whole set rather than once per row, so answering a bulk placement
 * costs a fixed number of queries plus one row read each.
 *
 * Ids naming no conversation are dropped, as are the legacy `private` rows:
 * every listing hides those by type (see `standardListingVisibilitySql`) and
 * migration cleanup deletes them, while the wire type collapses the value to
 * `standard`, so serving one would let a client holding a stale id resurrect
 * a row it can never see listed. A caller cannot tell the two cases apart
 * from the result, which is deliberate. The response says where rows are now,
 * and a row that is not in it is one this answer says nothing about.
 */
export function buildConversationSummaries(
  conversationIds: readonly string[],
): Array<ReturnType<typeof serializeConversationSummary>> {
  const conversations = conversationIds
    .map((id) => getConversation(id))
    .filter(
      (conversation): conversation is NonNullable<typeof conversation> =>
        conversation != null && conversation.conversationType !== "private",
    );
  if (conversations.length === 0) {
    return [];
  }
  const ids = conversations.map((conversation) => conversation.id);
  const bindings = getBindingsForConversations(ids);
  const attentionStates = getAttentionStateByConversationIds(ids);
  const displayMeta = getDisplayMetaForConversations(ids);
  const parentCache = new Map<string, ConversationRow | null>();

  return conversations.map((conversation) =>
    serializeConversationSummary({
      conversation,
      binding: bindings.get(conversation.id),
      attentionState: attentionStates.get(conversation.id),
      displayMeta: displayMeta.get(conversation.id),
      parentCache,
      isProcessing: isConversationProcessing(conversation.id),
    }),
  );
}

/**
 * Build a full conversation detail response from a conversation ID.
 *
 * The one-row shape of {@link buildConversationSummaries}, and it delegates
 * rather than repeating the hydration: a summary field or a visibility rule
 * added to one path has to reach the other, and two copies of the pipeline
 * are how they stop agreeing.
 *
 * Returns null when the conversation does not exist, and for the same reason
 * when it is a legacy `private` row.
 */
export function buildConversationDetailResponse(
  conversationId: string,
): { conversation: ReturnType<typeof serializeConversationSummary> } | null {
  const [conversation] = buildConversationSummaries([conversationId]);
  return conversation ? { conversation } : null;
}
