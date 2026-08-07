/**
 * A link back to a document the assistant changed during a turn, rendered at
 * the end of that turn's response.
 *
 * The link is derived durably from the turn's tool calls, which persist on the
 * message, and is hidden reactively while the document is visible. It does not
 * depend on point-in-time closed-ness captured when the turn finished: that
 * does not survive a reload, and on mobile the editor is a full-screen overlay,
 * so a visible transcript already means the editor is closed.
 *
 * The name comes from the documents query rather than the tool result, so the
 * link reads the same title the assets list and the Library show, including
 * after a rename. The link waits for that query and stays away from a document
 * no resolved list carries, so it never offers to open something that has been
 * deleted.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, FileText } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

import { useIsDocumentOpen } from "@/domains/chat/components/local-file/open-local-file";
import { documentsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { DocumentsGetResponse } from "@/generated/daemon/types.gen";

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
  const isOpen = useIsDocumentOpen(surfaceId);
  const displayName = useDocumentDisplayName(
    surfaceId,
    assistantId,
    conversationId,
  );

  if (isOpen || displayName == null) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      size="compact"
      className="mt-2 max-w-full gap-2 rounded-lg"
      aria-label={`Open ${displayName}`}
      data-testid="document-reopen-link"
      onClick={() => onOpenDocument(surfaceId)}
    >
      <FileText className="h-4 w-4 shrink-0 text-[var(--content-quiet)]" />
      <span className="min-w-0 truncate text-title-small text-[var(--content-strong)]">
        {displayName}
      </span>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[var(--content-faint)]" />
    </Button>
  );
}
