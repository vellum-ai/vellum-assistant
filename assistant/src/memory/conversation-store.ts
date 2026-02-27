// Re-export all conversation store functionality from focused sub-modules.
// Existing imports from this file continue to work without changes.

import { rawExec, rawGet, rawRun } from './db.js';
import { ensureDisplayOrderMigration } from './conversation-display-order-migration.js';

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
  getConversationThreadType,
  getMessageById,
  getMessages,
  type MessageMetadata,
  messageMetadataSchema,
  type MessageRow,
  parseConversation,
  parseMessage,
  provenanceFromGuardianContext,
  relinkAttachments,
  setConversationOriginChannelIfUnset,
  setConversationOriginInterfaceIfUnset,
  updateConversationContextWindow,
  updateConversationTitle,
  updateConversationUsage,
  updateMessageContent,
} from './conversation-crud.js';
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
} from './conversation-queries.js';

// Re-export for backward compat — callers that imported ensureColumns from here
export { ensureDisplayOrderMigration as ensureColumns } from './conversation-display-order-migration.js';

// ---------------------------------------------------------------------------
// CRUD functions for display_order and is_pinned
// ---------------------------------------------------------------------------

export function getDisplayOrder(conversationId: string): number | null {
  ensureDisplayOrderMigration();
  const row = rawGet<{ display_order: number | null }>(
    'SELECT display_order FROM conversations WHERE id = ?',
    conversationId,
  );
  return row?.display_order ?? null;
}

export function setDisplayOrder(conversationId: string, order: number | null): void {
  ensureDisplayOrderMigration();
  rawRun(
    'UPDATE conversations SET display_order = ? WHERE id = ?',
    order,
    conversationId,
  );
}

export function batchSetDisplayOrders(
  updates: Array<{ id: string; displayOrder: number | null; isPinned: boolean }>,
): void {
  ensureDisplayOrderMigration();
  rawExec('BEGIN');
  try {
    for (const update of updates) {
      rawRun(
        'UPDATE conversations SET display_order = ?, is_pinned = ? WHERE id = ?',
        update.displayOrder,
        update.isPinned ? 1 : 0,
        update.id,
      );
    }
    rawExec('COMMIT');
  } catch (err) {
    rawExec('ROLLBACK');
    throw err;
  }
}

export function setConversationPinned(conversationId: string, isPinned: boolean): void {
  ensureDisplayOrderMigration();
  rawRun(
    'UPDATE conversations SET is_pinned = ? WHERE id = ?',
    isPinned ? 1 : 0,
    conversationId,
  );
}

export function getConversationDisplayMeta(
  conversationId: string,
): { displayOrder: number | null; isPinned: boolean } {
  ensureDisplayOrderMigration();
  const row = rawGet<{ display_order: number | null; is_pinned: number | null }>(
    'SELECT display_order, is_pinned FROM conversations WHERE id = ?',
    conversationId,
  );
  return {
    displayOrder: row?.display_order ?? null,
    isPinned: (row?.is_pinned ?? 0) === 1,
  };
}

export function getDisplayMetaForConversations(
  conversationIds: string[],
): Map<string, { displayOrder: number | null; isPinned: boolean }> {
  ensureDisplayOrderMigration();
  const result = new Map<string, { displayOrder: number | null; isPinned: boolean }>();
  if (conversationIds.length === 0) return result;
  for (const id of conversationIds) {
    const row = rawGet<{ display_order: number | null; is_pinned: number | null }>(
      'SELECT display_order, is_pinned FROM conversations WHERE id = ?',
      id,
    );
    result.set(id, {
      displayOrder: row?.display_order ?? null,
      isPinned: (row?.is_pinned ?? 0) === 1,
    });
  }
  return result;
}
