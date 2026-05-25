/**
 * Sync invalidation wire contract.
 *
 * The daemon emits a `sync_changed` SSE event whenever a resource that the
 * client caches is invalidated (avatar, identity, conversation list,
 * feature flags, etc.). The event carries a list of opaque string `tags`;
 * each consumer subscribes to the tags it cares about and refetches the
 * matching cache entries on receipt.
 *
 * Wire shape is intentionally minimal: an array of strings plus an
 * optional `originClientId` for self-echo suppression. Tag semantics live
 * in the consumers, not in the wire — adding a new tag requires only
 * an emit site on the daemon and a handler on the client, with no schema
 * change here.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Tag namespace
// ---------------------------------------------------------------------------

/**
 * Canonical assistant-global sync tags. Each value is the literal string
 * the wire carries; the keys are stable client-side handles. Adding a new
 * tag is a non-breaking forward-compatible change as long as older clients
 * silently ignore unknown tags (which the parsing helper guarantees).
 */
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

/**
 * Per-conversation sync tags. Encoded as template-literal types so callers
 * get autocomplete on the conversationId prefix without losing the ability
 * to match an arbitrary id at runtime.
 */
export type ConversationSyncInvalidationTag =
  | `conversation:${string}:metadata`
  | `conversation:${string}:messages`;

/**
 * Discriminated union of every well-known tag plus an open `string`
 * branded slot. The branded `(string & {})` keeps autocomplete on the
 * literal options while still accepting forward-compat values from
 * newer daemons.
 */
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

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

/** Individual tag entry — a non-empty string at the wire level. */
export const SyncInvalidationTagSchema = z.string().min(1);

/**
 * `sync_changed` wire payload. Strict by default so unknown extra fields
 * surface as parse failures (we want drift to be loud).
 *
 * `originClientId` lets the daemon thread the client identity of whoever
 * caused the mutation through so other tabs can suppress their own echo.
 */
export const SyncChangedMessageSchema = z
  .object({
    type: z.literal("sync_changed"),
    tags: z.array(SyncInvalidationTagSchema).min(1),
    originClientId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Inferred TS type for the `sync_changed` wire payload.
 *
 * The `tags` field is `string[]` from Zod's perspective but the daemon
 * emits the more specific `SyncInvalidationTag[]`. Callers that need
 * autocomplete on tag literals should narrow via the public helpers above.
 */
export type SyncChangedMessage = z.infer<typeof SyncChangedMessageSchema>;

/**
 * Construct a validated `sync_changed` message. Deduplicates tags and
 * trims `originClientId`, then validates against the schema. Throws on
 * validation failure (callers should never produce invalid messages).
 */
export function buildSyncChangedMessage(
  tags: SyncInvalidationTag[],
  originClientId?: string,
): SyncChangedMessage {
  const dedupedTags = Array.from(new Set(tags));
  const trimmedOrigin = originClientId?.trim();
  return SyncChangedMessageSchema.parse({
    type: "sync_changed",
    tags: dedupedTags,
    ...(trimmedOrigin ? { originClientId: trimmedOrigin } : {}),
  });
}
