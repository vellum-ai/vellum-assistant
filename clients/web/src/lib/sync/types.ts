export const SYNC_TAGS = {
  assistantAvatar: "assistant:self:avatar",
  assistantIdentity: "assistant:self:identity",
  assistantConfig: "assistant:self:config",
  assistantSounds: "assistant:self:sounds",
  assistantSchedules: "assistant:self:schedules",
  assistantTheme: "assistant:self:theme",
  appsList: "apps:list",
  pluginsList: "plugins:list",
  conversationsList: "conversations:list",
  featureFlagsClient: "feature-flags:client",
  featureFlagsAssistant: "feature-flags:assistant",
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
  /**
   * Opaque per-tab/client identifier of the HTTP request whose mutation
   * caused this sync_changed emission, when known. Populated by the daemon
   * route handler from the `x-vellum-client-id` request header.
   *
   * Consumers MAY use this to suppress self-echoes: if their own client id
   * matches, the local UI has already applied the optimistic update via the
   * mutation's onSuccess and re-applying via the sync stream just doubles
   * work / fights the optimistic state.
   *
   * Absent for daemon-internal emissions (agent loop, FS watcher, schedules)
   * and for routes that haven't been plumbed through yet.
   */
  originClientId?: string;
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
