import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { AttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-preview-modal";

interface UseAttachmentPreviewResult {
  /**
   * Open the full-screen preview modal for the given attachment. Pass its
   * position in `attachments` when the list can hold two attachments with the
   * same id (legacy `rehydrated:N` rows), which the modal's id lookup cannot
   * tell apart.
   */
  openPreview: (attachment: DisplayAttachment, index?: number) => void;
  /** The rendered {@link AttachmentPreviewModal}, or `null` when nothing is
   *  open. Render this somewhere stable in the consuming component. */
  previewModal: ReactNode;
}

interface OpenPreview {
  attachment: DisplayAttachment;
  /** The caller's position, when it gave one; the modal falls back to its id. */
  index?: number;
}

/**
 * Owns the shared full-screen-preview plumbing for the attachment renderers
 * (the message squares and the composer strip): the open/close state and the
 * {@link AttachmentPreviewModal} element. Consumers call `openPreview(att)`
 * from an item's click handler and render `previewModal`.
 *
 * When multiple attachments are present, the modal renders prev/next gallery
 * navigation so the user can arrow between sibling images without closing.
 *
 * @param assistantId Forwarded to {@link AttachmentPreviewModal} so it can
 *   lazily fetch attachment content when `previewUrl` is missing.
 * @param attachments The full list of sibling attachments for gallery nav.
 */
export function useAttachmentPreview(
  assistantId?: string | null,
  attachments?: DisplayAttachment[],
): UseAttachmentPreviewResult {
  const [preview, setPreview] = useState<OpenPreview | null>(null);

  const openPreview = useCallback(
    (attachment: DisplayAttachment, index?: number) =>
      setPreview({ attachment, index }),
    [],
  );
  const handleClose = useCallback(() => setPreview(null), []);

  const handleNavigate = useCallback(
    (attachment: DisplayAttachment, index: number) =>
      setPreview({ attachment, index }),
    [],
  );

  const previewModal = preview ? (
    <AttachmentPreviewModal
      open
      onClose={handleClose}
      attachment={preview.attachment}
      currentIndex={preview.index}
      assistantId={assistantId}
      siblingAttachments={attachments}
      onNavigate={handleNavigate}
    />
  ) : null;

  return { openPreview, previewModal };
}
