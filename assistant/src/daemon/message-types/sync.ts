import { z } from "zod";

export const SYNC_TAGS = {
  assistantAvatar: "assistant:self:avatar",
  assistantIdentity: "assistant:self:identity",
  assistantConfig: "assistant:self:config",
  assistantSounds: "assistant:self:sounds",
  assistantSchedules: "assistant:self:schedules",
  conversationsList: "conversations:list",
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

export interface SyncChangedMessage {
  type: "sync_changed";
  tags: SyncInvalidationTag[];
}

export const SyncInvalidationTagSchema = z.string().min(1);

export const SyncChangedMessageSchema = z
  .object({
    type: z.literal("sync_changed"),
    tags: z.array(SyncInvalidationTagSchema).min(1),
  })
  .strict();

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
): SyncChangedMessage {
  const dedupedTags = Array.from(new Set(tags));
  const parsed = SyncChangedMessageSchema.parse({
    type: "sync_changed",
    tags: dedupedTags,
  });
  return parsed as SyncChangedMessage;
}

export type _SyncInvalidationServerMessages = SyncChangedMessage;
