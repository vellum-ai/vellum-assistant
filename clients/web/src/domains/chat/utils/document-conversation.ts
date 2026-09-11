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
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import {
  getEditChatConversationId,
  getEditChatDraftReplacement,
  setEditChatConversationId,
} from "@/utils/edit-chat-session";

/** The subset of a document's fields conversation resolution/linking needs. */
export interface DocumentConversationRef {
  surfaceId: string;
  conversationId: string;
}

/**
 * The server row a send about `doc` targets, when one is known without
 * minting: the row that replaced the document's own id once that id is a
 * client draft the daemon has retired, then the document's own linked
 * conversation, then the session-cached id from a previous resolution (4h
 * TTL, see `edit-chat-session.ts`).
 *
 * `undefined` is "no row yet", which a document open against a live draft
 * reads: that draft is an id the daemon has never heard of, and nothing has
 * replaced it. A caller that has to name a conversation mints one (see
 * {@link resolveDocumentConversationId}); a caller reading a property of the
 * row, such as the model it runs, has nothing to read yet.
 *
 * `ownIsDraft` is whether `doc.conversationId` is still a client-minted draft,
 * passed in so a React caller can subscribe to that mark and re-render when it
 * flips.
 */
export function peekDocumentConversationRow(
  doc: DocumentConversationRef,
  assistantId: string,
  ownIsDraft: boolean,
): string | undefined {
  const replacement = doc.conversationId
    ? getEditChatDraftReplacement(assistantId, doc.conversationId)
    : null;
  if (replacement) {
    return replacement;
  }
  const cached = getEditChatConversationId(assistantId, doc.surfaceId);
  if (ownIsDraft) {
    // A cache naming another row is a send that minted a row for this
    // document and failed to link it: that row is the one to reuse.
    return cached && cached !== doc.conversationId ? cached : undefined;
  }
  return doc.conversationId || cached || undefined;
}

/**
 * Resolve the conversation a document's assistant-facing actions should
 * target.
 *
 * The row {@link peekDocumentConversationRow} names, and a freshly minted
 * draft id when it names none.
 *
 * A document the daemon still reports as owned by a retired draft resolves to
 * the row that replaced it for as long as this tab's session cache holds the
 * replacement, whether or not the draft mark is still set and whether or not
 * the document's own relink has landed. A draft id is one the daemon has
 * never heard of, so sending against it would 404 on an assistant that
 * strict-looks-up conversation ids.
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
  const ownIsDraft = useConversationStore
    .getState()
    .draftConversationIds.has(doc.conversationId);
  return (
    peekDocumentConversationRow(doc, assistantId, ownIsDraft) ??
    (doc.conversationId || createDraftConversationId())
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
 * id an earlier attempt minted past without managing to link. That match is
 * only safe for a caller that has just checked the active assistant is still
 * the one its link went out under: the incoming assistant can have the same
 * document open against a conversation of its own, and a surface-keyed write
 * would hand it the outgoing assistant's row. The one caller is
 * `use-document-composer-submit.ts`, which runs that check immediately
 * before. A caller that cannot make it re-keys by conversation id instead,
 * the way {@link rekeyOpenedDocumentConversation} does.
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
 *
 * The open document is checked again once the link resolves rather than
 * trusted from before the await. `use-send-message.ts` calls this
 * fire-and-forget, so nothing upstream drops a call whose assistant changed
 * mid-flight, and the user can switch assistants and reopen the same surface
 * under the incoming one while the link is out. Writing the minted id then
 * would point the incoming assistant's document at a row belonging to the
 * assistant the user left.
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
  const current = useViewerStore.getState().openedDocumentState;
  if (
    useResolvedAssistantsStore.getState().activeAssistantId !== assistantId ||
    current?.source !== "document" ||
    current.surfaceId !== opened.surfaceId ||
    current.conversationId !== oldConversationId
  ) {
    return false;
  }
  useViewerStore
    .getState()
    .relinkOpenedDocumentConversation(oldConversationId, newConversationId);
  return true;
}
