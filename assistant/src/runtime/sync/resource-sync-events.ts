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

export function publishAvatarChanged(): void {
  broadcastMessage({
    type: "avatar_updated",
    avatarPath: getAvatarImagePath(),
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantAvatar]);
}

export function publishIdentityChanged(fields: IdentityFields): void {
  broadcastMessage({
    type: "identity_changed",
    name: fields.name,
    role: fields.role,
    personality: fields.personality,
    emoji: fields.emoji,
    home: fields.home,
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantIdentity]);
}

export function publishConfigChanged(): void {
  broadcastMessage({ type: "config_changed" });
  void publishSyncInvalidation([SYNC_TAGS.assistantConfig]);
}

export function publishSoundsConfigUpdated(): void {
  broadcastMessage({ type: "sounds_config_updated" });
  void publishSyncInvalidation([SYNC_TAGS.assistantSounds]);
}

export function publishSchedulesChanged(): void {
  void publishSyncInvalidation([SYNC_TAGS.assistantSchedules]);
}

export function publishConversationListChanged(
  reason: ConversationListInvalidatedReason,
): void {
  broadcastMessage({
    type: "conversation_list_invalidated",
    reason,
  });
  void publishSyncInvalidation([SYNC_TAGS.conversationsList]);
}

export function publishConversationMessagesChanged(
  conversationId: string,
): void {
  void publishSyncInvalidation([conversationMessagesSyncTag(conversationId)]);
}

export function publishConversationListAndMetadataChanged(
  reason: ConversationListInvalidatedReason,
  conversationIds: string | string[],
): void {
  const ids = Array.isArray(conversationIds)
    ? conversationIds
    : [conversationIds];
  broadcastMessage({
    type: "conversation_list_invalidated",
    reason,
  });
  void publishSyncInvalidation([
    SYNC_TAGS.conversationsList,
    ...ids.map((conversationId) => conversationMetadataSyncTag(conversationId)),
  ]);
}

export function publishConversationTitleChanged(
  conversationId: string,
  title: string,
): void {
  broadcastMessage(
    {
      type: "conversation_title_updated",
      conversationId,
      title,
    },
    conversationId,
  );
  void publishSyncInvalidation([
    SYNC_TAGS.conversationsList,
    conversationMetadataSyncTag(conversationId),
  ]);
}

export function publishConversationInferenceProfileChanged(params: {
  conversationId: string;
  profile: string | null;
  sessionId?: string | null;
  expiresAt?: number | null;
}): void {
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
  void publishSyncInvalidation([
    SYNC_TAGS.conversationsList,
    conversationMetadataSyncTag(params.conversationId),
  ]);
}
