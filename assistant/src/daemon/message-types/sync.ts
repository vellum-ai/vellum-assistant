import { z } from "zod";

export const SYNC_TAGS = {
  assistantAvatar: "assistant:self:avatar",
  assistantIdentity: "assistant:self:identity",
  assistantConfig: "assistant:self:config",
  assistantSounds: "assistant:self:sounds",
  assistantSchedules: "assistant:self:schedules",
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

export interface SyncChangedMessage {
  type: "sync_changed";
  tags: SyncInvalidationTag[];
  /**
   * Optional identifier of the client that originated the change. When set,
   * the server fan-out and clients themselves can suppress self-echoes so
   * the originating tab/process doesn't reinvalidate its own cache off its
   * own mutation. Daemon-internal emits (agent loop, FS watcher, cron) leave
   * this unset so the event fans out to every subscriber as before.
   */
  originClientId?: string;
}

export const SyncInvalidationTagSchema = z.string().min(1);

export const SyncChangedMessageSchema = z
  .object({
    type: z.literal("sync_changed"),
    tags: z.array(SyncInvalidationTagSchema).min(1),
    originClientId: z.string().min(1).optional(),
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
  originClientId?: string,
): SyncChangedMessage {
  const dedupedTags = Array.from(new Set(tags));
  const trimmedOrigin = originClientId?.trim();
  const parsed = SyncChangedMessageSchema.parse({
    type: "sync_changed",
    tags: dedupedTags,
    ...(trimmedOrigin ? { originClientId: trimmedOrigin } : {}),
  });
  return parsed as SyncChangedMessage;
}

export type _SyncInvalidationServerMessages = SyncChangedMessage;
