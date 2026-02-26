// Re-export all conversation store functionality from focused sub-modules.
// Existing imports from this file continue to work without changes.

import { rawGet, rawRun } from './db.js';

export {
  messageMetadataSchema,
  type MessageMetadata,
  provenanceFromGuardianContext,
  type ConversationRow,
  parseConversation,
  type MessageRow,
  parseMessage,
  createConversation,
  getConversation,
  getConversationThreadType,
  getConversationMemoryScopeId,
  deleteConversation,
  addMessage,
  getMessages,
  getMessageById,
  updateConversationTitle,
  updateConversationUsage,
  updateConversationContextWindow,
  clearAll,
  deleteLastExchange,
  type DeletedMemoryIds,
  updateMessageContent,
  relinkAttachments,
  deleteMessageById,
  setConversationOriginChannelIfUnset,
  getConversationOriginChannel,
  setConversationOriginInterfaceIfUnset,
  getConversationOriginInterface,
} from './conversation-crud.js';

export {
  listConversations,
  countConversations,
  getLatestConversation,
  getNextMessage,
  type PaginatedMessagesResult,
  getMessagesPaginated,
  isLastUserMessageToolResult,
  type ConversationSearchResult,
  searchConversations,
} from './conversation-queries.js';

// ---------------------------------------------------------------------------
// Runtime migration: display_order and is_pinned columns
// ---------------------------------------------------------------------------

function ensureDisplayOrderColumns(): void {
  try {
    rawRun('ALTER TABLE conversations ADD COLUMN display_order INTEGER');
  } catch {
    // Column already exists — ignore the error
  }
  try {
    rawRun('ALTER TABLE conversations ADD COLUMN is_pinned INTEGER DEFAULT 0');
  } catch {
    // Column already exists — ignore the error
  }
}

let displayOrderColumnsEnsured = false;

function ensureColumns(): void {
  if (!displayOrderColumnsEnsured) {
    ensureDisplayOrderColumns();
    displayOrderColumnsEnsured = true;
  }
}

// ---------------------------------------------------------------------------
// CRUD functions for display_order and is_pinned
// ---------------------------------------------------------------------------

export function getDisplayOrder(conversationId: string): number | null {
  ensureColumns();
  const row = rawGet<{ display_order: number | null }>(
    'SELECT display_order FROM conversations WHERE id = ?',
    conversationId,
  );
  return row?.display_order ?? null;
}

export function setDisplayOrder(conversationId: string, order: number | null): void {
  ensureColumns();
  rawRun(
    'UPDATE conversations SET display_order = ? WHERE id = ?',
    order,
    conversationId,
  );
}

export function batchSetDisplayOrders(
  updates: Array<{ id: string; displayOrder: number | null; isPinned: boolean }>,
): void {
  ensureColumns();
  for (const update of updates) {
    rawRun(
      'UPDATE conversations SET display_order = ?, is_pinned = ? WHERE id = ?',
      update.displayOrder,
      update.isPinned ? 1 : 0,
      update.id,
    );
  }
}

export function setConversationPinned(conversationId: string, isPinned: boolean): void {
  ensureColumns();
  rawRun(
    'UPDATE conversations SET is_pinned = ? WHERE id = ?',
    isPinned ? 1 : 0,
    conversationId,
  );
}

export function getConversationDisplayMeta(
  conversationId: string,
): { displayOrder: number | null; isPinned: boolean } {
  ensureColumns();
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
  ensureColumns();
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
