/**
 * Sync invalidation message types — re-export shim.
 *
 * The canonical source lives in `@vellumai/assistant-api/sse-events/sync`.
 * This file exists so existing daemon imports keep working without touching
 * 20 call sites; new code should import from `@vellumai/assistant-api`
 * directly.
 *
 * Daemon-internal naming convention (`_<Domain>ServerMessages`) is preserved
 * here since `assistant/src/daemon/message-protocol.ts` composes the
 * `ServerMessage` union from these aliases.
 */

export {
  SYNC_TAGS,
  SyncInvalidationTagSchema,
  SyncChangedMessageSchema,
  conversationMessagesSyncTag,
  conversationMetadataSyncTag,
  isConversationMetadataSyncTag,
  buildSyncChangedMessage,
} from "../../api/sse-events/sync.js";

export type {
  KnownSyncInvalidationTag,
  ConversationSyncInvalidationTag,
  SyncInvalidationTag,
  SyncChangedMessage,
} from "../../api/sse-events/sync.js";

import type { SyncChangedMessage } from "../../api/sse-events/sync.js";

export type _SyncInvalidationServerMessages = SyncChangedMessage;
