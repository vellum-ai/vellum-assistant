import type { DisplayAttachment } from "@/domains/chat/types/types";

import { AttachmentOverflowSquare } from "@/domains/chat/components/chat-attachments/attachment-overflow-square";
import { useAttachmentSquares } from "@/domains/chat/components/chat-attachments/use-attachment-squares";

interface MessageAttachmentsProps {
  attachments: DisplayAttachment[];
  /** Forwarded to {@link AttachmentPreviewModal} so it can lazily fetch
   *  attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
  /** Transcript message identity, forwarded to the files panel payload. */
  messageId: string;
}

/**
 * How many attachment squares render inline before the strip collapses.
 * A message with more than this many attachments shows the first
 * VISIBLE_LIMIT squares plus one overflow tile.
 */
const VISIBLE_LIMIT = 5;

/**
 * Read-only strip of attachment thumbnails rendered as a separate strip for
 * assistant messages (the user path renders attachments inside the message
 * bubble via {@link BubbleAttachments}). Every attachment is clickable and
 * opens a full-screen preview modal - the modal handles type-specific
 * rendering (image/video/fallback) and lazily fetches missing content when
 * needed. A hover overlay on each square provides direct download without
 * opening the preview first. Past {@link VISIBLE_LIMIT} the strip collapses
 * behind an overflow tile that opens the files side panel.
 */
export function MessageAttachments({
  attachments,
  assistantId,
  messageId,
}: MessageAttachmentsProps) {
  const { displayAttachments, renderSquare, previewModal } =
    useAttachmentSquares({ attachments, assistantId });

  if (attachments.length === 0) {
    return null;
  }

  const visible = displayAttachments.slice(0, VISIBLE_LIMIT);
  const overflowCount = displayAttachments.length - visible.length;

  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        {visible.map((att, index) => renderSquare(att, index))}
        {overflowCount > 0 && (
          <AttachmentOverflowSquare
            count={overflowCount}
            payload={{ messageId, attachments, assistantId }}
          />
        )}
      </div>
      {previewModal}
    </>
  );
}
