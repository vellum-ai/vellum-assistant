/**
 * Conversation-id resolution shared by every entry point that lets a user
 * talk to the assistant about a specific document: the standalone
 * `/documents/:surfaceId` route's "Submit Feedback" action
 * (`document-viewer-page.tsx`) and the mobile pinned document composer
 * (`use-document-composer-submit.ts`). Both need the same answer to "which
 * conversation does this document's assistant traffic belong to" — extracted
 * here so the fallback chain has exactly one owner.
 */
import { documentsByIdConversationsPost } from "@/generated/daemon/sdk.gen";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
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
 * target, and persist the resolution so the next call for this document
 * (same assistant, same tab) reuses the same id.
 *
 * Fallback order: the document's own linked conversation, then the
 * session-cached id from a previous resolution (4h TTL, see
 * `edit-chat-session.ts`), then a freshly minted draft id.
 */
export function resolveDocumentConversationId(
  doc: DocumentConversationRef,
  assistantId: string,
): string {
  const conversationId =
    doc.conversationId ||
    getEditChatConversationId(assistantId, doc.surfaceId) ||
    createDraftConversationId();

  setEditChatConversationId(assistantId, doc.surfaceId, conversationId);

  return conversationId;
}

/**
 * Link a resolved conversation id to the document server-side, when it
 * differs from the document's own (a session-cached id was reused, or a
 * fresh one was minted). Best-effort and silent: the daemon route may not
 * exist yet on an older assistant, and there is nothing actionable a caller
 * could do about that failure.
 */
export async function linkDocumentConversationIfNeeded(
  doc: DocumentConversationRef,
  assistantId: string,
  conversationId: string,
): Promise<void> {
  if (conversationId === doc.conversationId) {
    return;
  }
  try {
    await documentsByIdConversationsPost({
      path: { assistant_id: assistantId, id: doc.surfaceId },
      body: { conversationId },
      throwOnError: true,
    });
  } catch {
    // Best-effort — fails if the daemon doesn't have the route yet.
  }
}
