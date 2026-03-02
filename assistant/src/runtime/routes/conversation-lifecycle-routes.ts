import * as conversationStore from '../../memory/conversation-store.js';
import { httpError } from '../http-errors.js';

function decodeConversationId(rawId: string): string | null {
  try {
    const decoded = decodeURIComponent(rawId).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function handleArchiveConversation(rawConversationId: string): Response {
  const conversationId = decodeConversationId(rawConversationId);
  if (!conversationId) {
    return httpError('BAD_REQUEST', 'Invalid conversation ID', 400);
  }
  const archived = conversationStore.archiveConversation(conversationId);
  if (!archived) {
    return httpError('NOT_FOUND', 'Conversation not found', 404);
  }
  const updated = conversationStore.getConversation(conversationId);
  return Response.json({
    ok: true,
    conversationId,
    isArchived: true,
    ...(updated?.archivedAt != null ? { archivedAt: updated.archivedAt } : {}),
  });
}

export function handleUnarchiveConversation(rawConversationId: string): Response {
  const conversationId = decodeConversationId(rawConversationId);
  if (!conversationId) {
    return httpError('BAD_REQUEST', 'Invalid conversation ID', 400);
  }
  const unarchived = conversationStore.unarchiveConversation(conversationId);
  if (!unarchived) {
    return httpError('NOT_FOUND', 'Conversation not found', 404);
  }
  return Response.json({
    ok: true,
    conversationId,
    isArchived: false,
  });
}

export function handleHardDeleteConversation(rawConversationId: string): Response {
  const conversationId = decodeConversationId(rawConversationId);
  if (!conversationId) {
    return httpError('BAD_REQUEST', 'Invalid conversation ID', 400);
  }
  const deleted = conversationStore.hardDeleteConversation(conversationId);
  if (!deleted) {
    return httpError('NOT_FOUND', 'Conversation not found', 404);
  }
  return Response.json({
    ok: true,
    conversationId,
    deleted: true,
  });
}

