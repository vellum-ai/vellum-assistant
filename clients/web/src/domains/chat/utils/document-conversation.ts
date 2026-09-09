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
import { useConversationStore } from "@/stores/conversation-store";
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
 * A document's own id yields to the cache while that id is still a
 * client-minted draft and the cache names a different row. That pairing is a
 * send that minted a row for this document and failed to link it: the minted
 * row is the one to reuse, and the draft id is one the daemon has never heard
 * of, so sending against it would 404 on an assistant that strict-looks-up
 * conversation ids.
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
  const cached = getEditChatConversationId(assistantId, doc.surfaceId);
  if (
    cached &&
    cached !== doc.conversationId &&
    useConversationStore.getState().draftConversationIds.has(doc.conversationId)
  ) {
    return cached;
  }
  return doc.conversationId || cached || createDraftConversationId();
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
 * Point the document open in the viewer at a conversation the daemon has just
 * linked it to.
 *
 * The open document's `conversationId` is what
 * {@link resolveDocumentConversationId} trusts ahead of the session cache, and
 * what makes {@link linkDocumentConversationIfNeeded} skip its request, so it
 * stands for "this conversation is linked to this document", not "this is the
 * conversation the next send is aimed at". Only call it once the link is in
 * place.
 *
 * Matches on surface id, so it also moves a document left pointing at a draft
 * id an earlier attempt minted past without managing to link.
 */
export function markOpenedDocumentLinked(
  surfaceId: string,
  conversationId: string,
): void {
  const opened = useViewerStore.getState().openedDocumentState;
  if (
    !opened ||
    opened.source !== "document" ||
    opened.surfaceId !== surfaceId ||
    opened.conversationId === conversationId
  ) {
    return;
  }
  useViewerStore
    .getState()
    .relinkOpenedDocumentConversation(opened.conversationId, conversationId);
}

/**
 * When a draft conversation id a document is open against gets re-keyed to a
 * server-minted id (any send against that draft, whether from the document
 * composer itself or a chat page navigated to from `document-viewer-page`'s
 * "Submit Feedback"), re-link the document server-side to the minted id and
 * keep the document viewer store in sync.
 *
 * Without this, `openedDocumentState.conversationId` keeps pointing at the
 * dead draft id: it wins over the session cache in
 * {@link resolveDocumentConversationId} because it is truthy, so the next
 * send against the open document strict-lookups a conversation id the server
 * has never minted and 404s. Re-linking also keeps the document in the
 * minted conversation's turn context instead of dropping out of it.
 *
 * The link goes first, because the store update is what claims the link is in
 * place (see {@link markOpenedDocumentLinked}). Returns whether the open
 * document was re-keyed: `false` when the link failed, and when no document is
 * open against `oldConversationId` (match is on conversation id, not surface
 * id: the caller doesn't know which document, if any, was open against the
 * draft).
 */
export async function rekeyOpenedDocumentConversation(
  assistantId: string,
  oldConversationId: string,
  newConversationId: string,
): Promise<boolean> {
  const opened = useViewerStore.getState().openedDocumentState;
  if (
    !opened ||
    opened.source !== "document" ||
    opened.conversationId !== oldConversationId
  ) {
    return false;
  }
  const linked = await linkDocumentConversationIfNeeded(
    { surfaceId: opened.surfaceId, conversationId: oldConversationId },
    assistantId,
    newConversationId,
  );
  if (!linked) {
    return false;
  }
  markOpenedDocumentLinked(opened.surfaceId, newConversationId);
  return true;
}
