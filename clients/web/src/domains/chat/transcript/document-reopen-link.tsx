/**
 * The card for a document the assistant first reached during a turn, rendered
 * at the end of that turn's response. A later turn that changes the same
 * document draws nothing: by then the document is in the conversation's assets,
 * where the header pill lists it and lights its unseen dot (see
 * `resolve-response-artifacts.ts`).
 *
 * This is the single affordance a thread owes each document it touched. The
 * daemon also emits an inline `document_preview` surface where the tool ran,
 * but the transcript does not draw that one (see `response-artifacts.ts` and
 * `message-content.ts`): one document produced two cards in the
 * same response, at two different sizes, whenever a create was followed by an
 * edit.
 *
 * The card is derived durably from the turn's tool calls and the response's
 * preview surfaces, which both persist on the message, so it survives a reload.
 * It stays put while the document is open: a document is an artifact of the
 * turn that produced it, so the row that names it should not appear and vanish
 * as the viewer opens and closes.
 *
 * The name comes from the documents query rather than the tool result, so the
 * card reads the same title the assets list and the Library show, including
 * after a rename. It waits for that query and stays away from a document no
 * resolved list carries, so it never offers to open something that has been
 * deleted.
 */

import { useQuery } from "@tanstack/react-query";

import { DocumentCard } from "@/domains/chat/components/document-card";
import { useIsDocumentOpen } from "@/domains/chat/components/local-file/open-local-file";
import { documentsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { DocumentsGetResponse } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";

/** Label for a document the documents query lists under an empty title. */
const FALLBACK_DOCUMENT_NAME = "Untitled document";

/**
 * Title of `surfaceId` within one documents response: `null` when the response
 * does not carry it, otherwise its title ({@link FALLBACK_DOCUMENT_NAME} when
 * that title is empty).
 */
function selectDocumentTitle(
  response: DocumentsGetResponse,
  surfaceId: string,
): string | null {
  const found = response.documents.find((doc) => doc.surfaceId === surfaceId);
  if (!found) {
    return null;
  }
  return found.title.trim() === "" ? FALLBACK_DOCUMENT_NAME : found.title;
}

/**
 * Title of `surfaceId` in one documents list: `undefined` until that list
 * resolves and `null` once a resolved list does not carry the document.
 *
 * With a conversation the key matches the assets pill's, so both read one cache
 * entry and one invalidation refreshes both. Without one the key drops the
 * filter and reads the assistant-wide list, which no pill shares.
 */
function useDocumentTitle(
  surfaceId: string,
  assistantId: string | null | undefined,
  conversationId: string | null | undefined,
  enabled: boolean,
): string | null | undefined {
  const { data: title } = useQuery({
    ...documentsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      ...(conversationId ? { query: { conversationId } } : {}),
    }),
    enabled,
    select: (response) => selectDocumentTitle(response, surfaceId),
  });
  return title;
}

/**
 * Title to render for `surfaceId`: `undefined` while it is still being
 * resolved, `null` once no list carries the document.
 *
 * The conversation-scoped list is asked first so the link reads the same cache
 * entry as the assets pill. A miss there is not an absence: the assistant can
 * edit any document it can reach, and an edit does not link the document to the
 * conversation it was made from, so a document reached from an older
 * conversation is missing from this one's list while still existing. The
 * assistant-wide list settles that, and only a miss in both hides the link.
 */
function useDocumentDisplayName(
  surfaceId: string,
  assistantId?: string | null,
  conversationId?: string | null,
): string | null | undefined {
  const hasAssistant = Boolean(assistantId);
  const scopedTitle = useDocumentTitle(
    surfaceId,
    assistantId,
    conversationId,
    hasAssistant,
  );
  const assistantWideTitle = useDocumentTitle(
    surfaceId,
    assistantId,
    null,
    hasAssistant && Boolean(conversationId) && scopedTitle === null,
  );

  if (conversationId && scopedTitle === null) {
    return assistantWideTitle;
  }
  return scopedTitle;
}

export interface DocumentReopenLinkProps {
  /** Surface id of the document the turn changed. */
  surfaceId: string;
  /** Assistant the documents query reads through. */
  assistantId?: string | null;
  /** Conversation the document belongs to. */
  conversationId?: string | null;
  onOpenDocument: (surfaceId: string) => void;
}

export function DocumentReopenLink({
  surfaceId,
  assistantId,
  conversationId,
  onOpenDocument,
}: DocumentReopenLinkProps) {
  const { t } = useTranslation("chat");
  const displayName = useDocumentDisplayName(
    surfaceId,
    assistantId,
    conversationId,
  );
  const isOpen = useIsDocumentOpen(surfaceId);

  if (displayName == null) {
    return null;
  }

  return (
    <DocumentCard
      documentName={displayName}
      isOpen={isOpen}
      onOpen={() => onOpenDocument(surfaceId)}
      ariaLabel={t("documentReopenLink.openAria", { name: displayName })}
      testId="document-reopen-link"
    />
  );
}
