/**
 * Web-side sync types.
 *
 * The wire-shared bits (tag namespace, event shape, build/parse helpers)
 * come from `@vellumai/assistant-api/sse-events/sync` — see
 * `assistant/src/api/README.md` for the source-as-package rationale.
 *
 * What stays local: parsing helpers that exist only on the client side
 * (`parseConversationSyncTag`, `ConversationSyncResource`,
 * `ParsedConversationSyncTag`, `isConversationMessagesSyncTag`). They
 * have no daemon-side consumer today.
 */

import type { SyncChangedMessage } from "@vellumai/assistant-api/sse-events/sync";

export {
  SYNC_TAGS,
  conversationMessagesSyncTag,
  conversationMetadataSyncTag,
  isConversationMetadataSyncTag,
} from "@vellumai/assistant-api/sse-events/sync";

export type {
  KnownSyncInvalidationTag,
  ConversationSyncInvalidationTag,
  SyncInvalidationTag,
  SyncChangedMessage,
} from "@vellumai/assistant-api/sse-events/sync";

/**
 * Web-side alias for the canonical `SyncChangedMessage` wire shape.
 *
 * Web code historically called this "event"; the daemon calls it "message"
 * (wire payload). Keeping the alias avoids renaming every web call site in
 * this PR. New code on either side should prefer `SyncChangedMessage`.
 */
export type SyncChangedEvent = SyncChangedMessage;

// ---------------------------------------------------------------------------
// Web-only helpers (no daemon equivalent)
// ---------------------------------------------------------------------------

export type ConversationSyncResource = "metadata" | "messages";

export interface ParsedConversationSyncTag {
  conversationId: string;
  resource: ConversationSyncResource;
}

const CONVERSATION_SYNC_TAG_RE =
  /^conversation:([^:]+):(metadata|messages)$/;

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

export function isConversationMessagesSyncTag(
  tag: string,
): tag is `conversation:${string}:messages` {
  return parseConversationSyncTag(tag)?.resource === "messages";
}
