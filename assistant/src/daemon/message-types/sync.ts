import { z } from "zod";

import {
  type SyncChangedEvent,
  SyncChangedEventSchema,
} from "../../api/events/sync-changed.js";

export { type SyncChangedEvent, SyncChangedEventSchema };

export const SYNC_TAGS = {
  assistantAvatar: "assistant:self:avatar",
  assistantIdentity: "assistant:self:identity",
  assistantIdentityIntro: "assistant:self:identity-intro",
  assistantConfig: "assistant:self:config",
  assistantSounds: "assistant:self:sounds",
  assistantSchedules: "assistant:self:schedules",
  appsList: "apps:list",
  conversationsList: "conversations:list",
  featureFlagsClient: "feature-flags:client",
  featureFlagsAssistant: "feature-flags:assistant",
} as const;

export type KnownSyncInvalidationTag =
  (typeof SYNC_TAGS)[keyof typeof SYNC_TAGS];

export type ConversationSyncInvalidationTag =
  | `conversation:${string}:messages`
  | `conversation:${string}:metadata`;

export type SyncInvalidationTag =
  | KnownSyncInvalidationTag
  | ConversationSyncInvalidationTag
  | (string & {});

export const SyncInvalidationTagSchema = z.string().min(1);

export function conversationMessagesSyncTag(
  conversationId: string,
): ConversationSyncInvalidationTag {
  return `conversation:${conversationId}:messages`;
}

export function conversationMetadataSyncTag(
  conversationId: string,
): ConversationSyncInvalidationTag {
  return `conversation:${conversationId}:metadata`;
}

export function buildSyncChangedMessage(
  tags: SyncInvalidationTag[],
  originClientId?: string,
): SyncChangedEvent {
  const dedupedTags = Array.from(new Set(tags));
  const trimmedOrigin = originClientId?.trim();
  return SyncChangedEventSchema.parse({
    type: "sync_changed",
    tags: dedupedTags,
    ...(trimmedOrigin ? { originClientId: trimmedOrigin } : {}),
  });
}

export type _SyncInvalidationServerMessages = SyncChangedEvent;
