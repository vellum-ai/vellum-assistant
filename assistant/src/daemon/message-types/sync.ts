import { z } from "zod";

// Durable sync messages are resource invalidations, not realtime token/tool
// stream events. Clients use the tags to decide which local cache/store entries
// to refetch, and use the cursor to recover missed invalidations.

export const SYNC_RESOURCES = [
  "assistant",
  "conversation",
  "conversations",
] as const;

export type SyncResource = (typeof SYNC_RESOURCES)[number];

export const SYNC_OPERATIONS = [
  "created",
  "updated",
  "deleted",
  "invalidated",
] as const;

export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

export const SYNC_TAGS = {
  assistantAvatar: "assistant:self:avatar",
  assistantIdentity: "assistant:self:identity",
  assistantConfig: "assistant:self:config",
  assistantSounds: "assistant:self:sounds",
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

export interface SyncChange {
  cursor: number;
  createdAt: number;
  resource: SyncResource;
  resourceId: string;
  op: SyncOperation;
  version?: number;
  invalidatedTags: SyncInvalidationTag[];
  originClientId?: string;
  metadata?: Record<string, unknown>;
}

export interface SyncChangedMessage {
  type: "sync_changed";
  cursor: number;
  tags: SyncInvalidationTag[];
  changes: SyncChange[];
  originClientId?: string;
}

export const SyncResourceSchema = z.enum(SYNC_RESOURCES);
export const SyncOperationSchema = z.enum(SYNC_OPERATIONS);
export const SyncInvalidationTagSchema = z.string().min(1);

export const SyncChangeSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    resource: SyncResourceSchema,
    resourceId: z.string().min(1),
    op: SyncOperationSchema,
    version: z.number().int().nonnegative().optional(),
    invalidatedTags: z.array(SyncInvalidationTagSchema).min(1),
    originClientId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const SyncChangedMessageSchema = z
  .object({
    type: z.literal("sync_changed"),
    cursor: z.number().int().nonnegative(),
    tags: z.array(SyncInvalidationTagSchema).min(1),
    changes: z.array(SyncChangeSchema).min(1),
    originClientId: z.string().min(1).optional(),
  })
  .strict();

export function buildSyncChangedMessage(
  changes: SyncChange[],
  originClientId?: string,
): SyncChangedMessage {
  if (changes.length === 0) {
    throw new Error("sync_changed requires at least one persisted change");
  }
  const tags = Array.from(
    new Set(changes.flatMap((change) => change.invalidatedTags)),
  );
  return {
    type: "sync_changed",
    cursor: Math.max(...changes.map((change) => change.cursor)),
    tags,
    changes,
    ...(originClientId ? { originClientId } : {}),
  };
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SyncInvalidationServerMessages = SyncChangedMessage;
