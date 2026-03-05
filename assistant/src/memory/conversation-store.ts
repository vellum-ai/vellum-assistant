// Re-export all conversation store functionality from focused sub-modules.
// Existing imports from this file continue to work without changes.

import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { rawExec, rawGet, rawRun } from "./db.js";

export {
  addMessage,
  clearAll,
  type ConversationRow,
  createConversation,
  deleteConversation,
  type DeletedMemoryIds,
  deleteLastExchange,
  deleteMessageById,
  getConversation,
  getConversationMemoryScopeId,
  getConversationOriginChannel,
  getConversationOriginInterface,
  getConversationRecentProvenanceTrustClass,
  getConversationThreadType,
  getMessageById,
  getMessages,
  type MessageMetadata,
  messageMetadataSchema,
  type MessageRow,
  parseConversation,
  parseMessage,
  provenanceFromTrustContext,
  relinkAttachments,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
  updateConversationContextWindow,
  updateConversationTitle,
  updateConversationUsage,
  updateMessageContent,
} from "./conversation-crud.js";
export {
  type ConversationSearchResult,
  countConversations,
  getLatestConversation,
  getMessagesPaginated,
  getNextMessage,
  isLastUserMessageToolResult,
  listConversations,
  type PaginatedMessagesResult,
  searchConversations,
} from "./conversation-queries.js";

// Re-export for backward compat — callers that imported ensureColumns from here
export { ensureDisplayOrderMigration as ensureColumns } from "./conversation-display-order-migration.js";

// ---------------------------------------------------------------------------
// CRUD functions for display_order and is_pinned
// ---------------------------------------------------------------------------

export function batchSetDisplayOrders(
  updates: Array<{
    id: string;
    displayOrder: number | null;
    isPinned: boolean;
  }>,
): void {
  ensureDisplayOrderMigration();
  rawExec("BEGIN");
  try {
    for (const update of updates) {
      rawRun(
        "UPDATE conversations SET display_order = ?, is_pinned = ? WHERE id = ?",
        update.displayOrder,
        update.isPinned ? 1 : 0,
        update.id,
      );
    }
    rawExec("COMMIT");
  } catch (err) {
    rawExec("ROLLBACK");
    throw err;
  }
}

export function getDisplayMetaForConversations(
  conversationIds: string[],
): Map<string, { displayOrder: number | null; isPinned: boolean }> {
  ensureDisplayOrderMigration();
  const result = new Map<
    string,
    { displayOrder: number | null; isPinned: boolean }
  >();
  if (conversationIds.length === 0) return result;
  for (const id of conversationIds) {
    const row = rawGet<{
      display_order: number | null;
      is_pinned: number | null;
    }>("SELECT display_order, is_pinned FROM conversations WHERE id = ?", id);
    result.set(id, {
      displayOrder: row?.display_order ?? null,
      isPinned: (row?.is_pinned ?? 0) === 1,
    });
  }
  return result;
}
