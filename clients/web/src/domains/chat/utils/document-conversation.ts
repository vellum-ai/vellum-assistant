/**
 * Conversation-id resolution shared by every entry point that lets a user
 * talk to the assistant about a specific document: the standalone
 * `/documents/:surfaceId` route's "Submit Feedback" action
 * (`document-viewer-page.tsx`) and the mobile pinned document composer
 * (`use-document-composer-submit.ts`). Both need the same answer to "which
 * conversation does this document's assistant traffic belong to": extracted
 * here so the fallback chain has exactly one owner.
 */
import { documentsByIdConversationsPost } from "@/generated/daemon/sdk.gen";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useViewerStore } from "@/stores/viewer-store";
import {
  getEditChatConversationId,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";

/** The subset of a document's fields conversation resolution/linking needs. */
export interface DocumentConversationRef {
  surfaceId: string;
  conversationId: string;
}

/**
 * Resolve the conversation a document's assistant-facing actions should
 * target.
 *
 * Fallback order: the document's own linked conversation, then the
 * session-cached id from a previous resolution (4h TTL, see
 * `edit-chat-session.ts`), then a freshly minted draft id.
 *
 * Deliberately does not persist the result: a caller that resolves a fresh or
 * reused id but never successfully sends against it must not leave that id
 * cached, or the next resolution would reuse an id the server has never heard
 * of for the rest of the cache's TTL. Callers persist explicitly, once they
 * know the id is good, via {@link persistDocumentConversationId}.
 */
export function resolveDocumentConversationId(
  doc: DocumentConversationRef,
  assistantId: string,
): string {
  return (
    doc.conversationId ||
    getEditChatConversationId(assistantId, doc.surfaceId) ||
    createDraftConversationId()
  );
}

/**
 * Cache a resolved conversation id for reuse by a later resolution for the
 * same document. Call only once the id is known good: a pre-existing or
 * previously-cached id that a send just succeeded against, or the id an
 * assistant actually minted for a fresh draft, never speculatively.
 *
 * No-ops when `conversationId` matches the document's own `conversationId`:
 * that id is already recoverable straight from the document, with nothing to
 * cache.
 */
export function persistDocumentConversationId(
  doc: DocumentConversationRef,
  assistantId: string,
  conversationId: string,
): void {
  if (conversationId === doc.conversationId) {
    return;
  }
  setEditChatConversationId(assistantId, doc.surfaceId, conversationId);
}

/**
 * Link a resolved conversation id to the document server-side, when it
 * differs from the document's own (a session-cached id was reused, or a
 * fresh one was minted).
 *
 * Never throws: the daemon route may not exist yet on an older assistant.
 * Returns whether the link is in place, `true` also covering the no-op case
 * where the id already is the document's own, so a caller that knows its
 * assistant has the route can hold back a turn that would otherwise run
 * without the document.
 */
export async function linkDocumentConversationIfNeeded(
  doc: DocumentConversationRef,
  assistantId: string,
  conversationId: string,
): Promise<boolean> {
  if (conversationId === doc.conversationId) {
    return true;
  }
  try {
    await documentsByIdConversationsPost({
      path: { assistant_id: assistantId, id: doc.surfaceId },
      body: { conversationId },
      throwOnError: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * When a draft conversation id a document is open against gets re-keyed to a
 * server-minted id (any send against that draft, whether from the document
 * composer itself or a chat page navigated to from `document-viewer-page`'s
 * "Submit Feedback"), keep the document viewer store in sync and re-link the
 * document server-side to the minted id.
 *
 * Without this, `openedDocumentState.conversationId` keeps pointing at the
 * dead draft id: it wins over the session cache in
 * {@link resolveDocumentConversationId} because it is truthy, so the next
 * send against the open document strict-lookups a conversation id the server
 * has never minted and 404s. Re-linking also keeps the document in the
 * minted conversation's turn context instead of dropping out of it.
 *
 * No-ops when no document is open against `oldConversationId` (match is on
 * conversation id, not surface id: the caller doesn't know which document,
 * if any, was open against the draft).
 */
export async function rekeyOpenedDocumentConversation(
  assistantId: string,
  oldConversationId: string,
  newConversationId: string,
): Promise<void> {
  const opened = useViewerStore.getState().openedDocumentState;
  if (
    !opened ||
    opened.source !== "document" ||
    opened.conversationId !== oldConversationId
  ) {
    return;
  }
  useViewerStore
    .getState()
    .relinkOpenedDocumentConversation(oldConversationId, newConversationId);
  await linkDocumentConversationIfNeeded(
    { surfaceId: opened.surfaceId, conversationId: oldConversationId },
    assistantId,
    newConversationId,
  );
}
