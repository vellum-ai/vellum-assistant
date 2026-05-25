import type { IdentityFields } from "../../daemon/handlers/identity.js";
import type { ConversationListInvalidatedReason } from "../../daemon/message-types/conversations.js";
import {
  conversationMessagesSyncTag,
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../../daemon/message-types/sync.js";
import { getAvatarImagePath } from "../../util/platform.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { publishSyncInvalidation } from "./sync-publisher.js";

export function publishAvatarChanged(originClientId?: string): void {
  broadcastMessage({
    type: "avatar_updated",
    avatarPath: getAvatarImagePath(),
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantAvatar], originClientId);
}

export function publishIdentityChanged(
  fields: IdentityFields,
  originClientId?: string,
): void {
  broadcastMessage({
    type: "identity_changed",
    name: fields.name,
    role: fields.role,
    personality: fields.personality,
    emoji: fields.emoji,
    home: fields.home,
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantIdentity], originClientId);
}

export function publishConfigChanged(originClientId?: string): void {
  broadcastMessage({ type: "config_changed" });
  void publishSyncInvalidation([SYNC_TAGS.assistantConfig], originClientId);
}

export function publishSoundsConfigUpdated(originClientId?: string): void {
  broadcastMessage({ type: "sounds_config_updated" });
  void publishSyncInvalidation([SYNC_TAGS.assistantSounds], originClientId);
}

export function publishSchedulesChanged(originClientId?: string): void {
  void publishSyncInvalidation([SYNC_TAGS.assistantSchedules], originClientId);
}

export function publishConversationListChanged(
  reason: ConversationListInvalidatedReason,
  originClientId?: string,
): void {
  broadcastMessage({
    type: "conversation_list_invalidated",
    reason,
  });
  void publishSyncInvalidation([SYNC_TAGS.conversationsList], originClientId);
}

export function publishConversationMessagesChanged(
  conversationId: string,
  originClientId?: string,
): void {
  void publishSyncInvalidation(
    [conversationMessagesSyncTag(conversationId)],
    originClientId,
  );
}

export function publishConversationListAndMetadataChanged(
  reason: ConversationListInvalidatedReason,
  conversationIds: string | string[],
  originClientId?: string,
): void {
  const ids = Array.isArray(conversationIds)
    ? conversationIds
    : [conversationIds];
  broadcastMessage({
    type: "conversation_list_invalidated",
    reason,
  });
  void publishSyncInvalidation(
    [
      SYNC_TAGS.conversationsList,
      ...ids.map((conversationId) =>
        conversationMetadataSyncTag(conversationId),
      ),
    ],
    originClientId,
  );
}

/**
 * Server push — a single conversation's attention/seen state changed.
 *
 * Carries the full post-mutation state inline so subscribers can patch
 * their cached conversation row directly without refetching the paginated
 * conversation list. This deliberately publishes neither a
 * `conversation_list_invalidated` broadcast nor any `sync_changed` tag:
 * the seen flag is per-conversation attention state, not list-shaped, and
 * tagging it as `conversationsList` previously triggered a full sidebar
 * drain (`limit=50&offset=0..N` for foreground + background variants) on
 * every conversation switch that landed on an unseen conversation.
 *
 * The originating client's echo of this event is a no-op: it has already
 * applied the same patch optimistically (`markConversationSeenLocal` on
 * web). Other clients (sibling tabs, additional devices) receive it and
 * patch their cache.
 *
 * @see ../../daemon/message-types/conversations.ts → `ConversationSeenChanged`
 */
export function publishConversationSeenChanged(
  params: {
    conversationId: string;
    hasUnseenLatestAssistantMessage: boolean;
    latestAssistantMessageAt: number | null;
    lastSeenAssistantMessageAt: number | null;
  },
  // Reserved for symmetry with the rest of this file. The hub's
  // self-echo suppression only fires on `sync_changed`, and this
  // publisher emits no sync tag — so the originating client receives
  // the typed event back (idempotent no-op cache patch). Threading an
  // `originClientId` here lets future callers wire suppression in if
  // we ever extend the hub to filter typed events.
  _originClientId?: string,
): void {
  broadcastMessage(
    {
      type: "conversation_seen_changed",
      conversationId: params.conversationId,
      hasUnseenLatestAssistantMessage: params.hasUnseenLatestAssistantMessage,
      latestAssistantMessageAt: params.latestAssistantMessageAt,
      lastSeenAssistantMessageAt: params.lastSeenAssistantMessageAt,
    },
    params.conversationId,
  );
}

export function publishConversationTitleChanged(
  conversationId: string,
  title: string,
  originClientId?: string,
): void {
  broadcastMessage(
    {
      type: "conversation_title_updated",
      conversationId,
      title,
    },
    conversationId,
  );
  void publishSyncInvalidation(
    [SYNC_TAGS.conversationsList, conversationMetadataSyncTag(conversationId)],
    originClientId,
  );
}

export function publishConversationInferenceProfileChanged(
  params: {
    conversationId: string;
    profile: string | null;
    sessionId?: string | null;
    expiresAt?: number | null;
  },
  originClientId?: string,
): void {
  broadcastMessage(
    {
      type: "conversation_inference_profile_updated",
      conversationId: params.conversationId,
      profile: params.profile,
      sessionId: params.sessionId,
      expiresAt: params.expiresAt,
    },
    params.conversationId,
  );
  void publishSyncInvalidation(
    [
      SYNC_TAGS.conversationsList,
      conversationMetadataSyncTag(params.conversationId),
    ],
    originClientId,
  );
}
