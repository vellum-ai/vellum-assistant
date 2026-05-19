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
  | `conversation:${string}:metadata`
  | `conversation:${string}:messages`;

export type SyncInvalidationTag =
  | KnownSyncInvalidationTag
  | ConversationSyncInvalidationTag
  | (string & {});

export interface SyncChangedEvent {
  type: "sync_changed";
  tags: SyncInvalidationTag[];
}

export type ConversationSyncResource = "metadata" | "messages";

export interface ParsedConversationSyncTag {
  conversationId: string;
  resource: ConversationSyncResource;
}

const CONVERSATION_SYNC_TAG_RE =
  /^conversation:([^:]+):(metadata|messages)$/;

export function conversationMetadataSyncTag(
  conversationId: string,
): ConversationSyncInvalidationTag {
  return `conversation:${conversationId}:metadata`;
}

export function conversationMessagesSyncTag(
  conversationId: string,
): ConversationSyncInvalidationTag {
  return `conversation:${conversationId}:messages`;
}

export function parseConversationSyncTag(
  tag: string,
): ParsedConversationSyncTag | null {
  const match = CONVERSATION_SYNC_TAG_RE.exec(tag);
  if (!match) {
    return null;
  }
  return {
    conversationId: match[1]!,
    resource: match[2] as ConversationSyncResource,
  };
}

export function isConversationMetadataSyncTag(
  tag: string,
): tag is `conversation:${string}:metadata` {
  return parseConversationSyncTag(tag)?.resource === "metadata";
}

export function isConversationMessagesSyncTag(
  tag: string,
): tag is `conversation:${string}:messages` {
  return parseConversationSyncTag(tag)?.resource === "messages";
}
