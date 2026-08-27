import { z } from "zod";

import {
  type SyncChangedEvent,
  SyncChangedEventSchema,
} from "../../api/events/sync-changed.js";

export { type SyncChangedEvent, SyncChangedEventSchema };

export const SYNC_TAGS = {
  assistantAvatar: "assistant:self:avatar",
  assistantIdentity: "assistant:self:identity",
  assistantConfig: "assistant:self:config",
  assistantSounds: "assistant:self:sounds",
  assistantSchedules: "assistant:self:schedules",
  assistantTheme: "assistant:self:theme",
  appsList: "apps:list",
  documentsList: "documents:list",
  pluginsList: "plugins:list",
  conversationsList: "conversations:list",
  featureFlagsClient: "feature-flags:client",
  featureFlagsAssistant: "feature-flags:assistant",
  /** ACP credential-failure markers, which drive the inline Connect card.
   *  Invalidated when a token write retires them, so a client holding a
   *  restored prompt for the replaced token stops offering it. */
  acpAuthRecovery: "acp:auth-recovery",
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
