/**
 * The shared attachment-square renderer behind every surface that lists a
 * message's attachments: the assistant strip ({@link MessageAttachments}), the
 * user bubble ({@link BubbleAttachments}), and the files side panel
 * ({@link MessageFilesPanel}).
 *
 * Owns the three pieces those surfaces must agree on:
 *
 *  - the failed-decode fallback - image previews the browser cannot decode
 *    (e.g. a HEIC blob on a Chromium renderer) get their `previewUrl` nulled
 *    at their own position, so the square falls back to its file-kind icon
 *    instead of a dead image, and the preview modal refetches stored bytes
 *    instead of the broken blob;
 *  - the preview modal plus its gallery siblings;
 *  - the download forwarder.
 *
 * Callers own only their own layout: they map over {@link displayAttachments}
 * and place `renderSquare(att, index)` inside whatever container they need.
 */

import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import {
  previewEntryKey,
  useFailedPreviewIds,
} from "@/domains/chat/components/chat-attachments/use-failed-preview-ids";

interface UseAttachmentSquaresOptions {
  attachments: DisplayAttachment[];
  /** Forwarded to the preview modal and the download helper so both can
   *  lazily fetch attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
}

interface UseAttachmentSquaresResult {
  /** `attachments` with the `previewUrl` of every undecodable image nulled.
   *  Render from this list rather than the input, so a dead preview cannot
   *  reach the DOM. */
  displayAttachments: DisplayAttachment[];
  /** One attachment square, wired to the preview modal, the downloader, and
   *  the failed-decode fallback. `index` is the position in
   *  {@link displayAttachments}. */
  renderSquare: (attachment: DisplayAttachment, index: number) => ReactNode;
  /** Opens the preview modal, for call sites that render their own affordance
   *  alongside the squares (the bubble's large inline images). Pass the
   *  attachment's position in {@link displayAttachments}, which resolves a list
   *  holding two attachments with the same id. */
  openPreview: (attachment: DisplayAttachment, index?: number) => void;
  /** Records an attachment whose preview the browser could not decode. Takes
   *  the position too, so a list holding two attachments with the same id
   *  keeps the good twin's preview. */
  markImageFailed: (id: string, index: number) => void;
  /** The rendered preview modal, or `null`. Render it somewhere stable. */
  previewModal: ReactNode;
}

export function useAttachmentSquares({
  attachments,
  assistantId,
}: UseAttachmentSquaresOptions): UseAttachmentSquaresResult {
  const { failedIds, markFailed } = useFailedPreviewIds();

  const markImageFailed = useCallback(
    (id: string, index: number) => markFailed(previewEntryKey(id, index)),
    [markFailed],
  );

  const displayAttachments = useMemo(
    () =>
      failedIds.size === 0
        ? attachments
        : attachments.map((att, index) =>
            failedIds.has(previewEntryKey(att.id, index))
              ? { ...att, previewUrl: null }
              : att,
          ),
    [attachments, failedIds],
  );

  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    displayAttachments,
  );

  const renderSquare = useCallback(
    (attachment: DisplayAttachment, index: number) => (
      <MessageAttachmentSquare
        key={previewEntryKey(attachment.id, index)}
        attachment={attachment}
        onPreview={() => openPreview(attachment, index)}
        // Download falls back to previewUrl when the daemon content fetch is
        // unavailable, so it takes the UNSANITIZED attachment - a blob that
        // can't be rendered is still valid bytes to save.
        onDownload={() =>
          void downloadAttachment(attachments[index] ?? attachment, assistantId)
        }
        onPreviewError={() => markImageFailed(attachment.id, index)}
      />
    ),
    [attachments, assistantId, openPreview, markImageFailed],
  );

  return {
    displayAttachments,
    renderSquare,
    openPreview,
    markImageFailed,
    previewModal,
  };
}
