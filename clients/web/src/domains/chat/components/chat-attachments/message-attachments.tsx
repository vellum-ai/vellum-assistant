import { useCallback } from "react";
import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { AttachmentOverflowSquare } from "@/domains/chat/components/chat-attachments/attachment-overflow-square";
import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";

interface MessageAttachmentsProps {
  attachments: DisplayAttachment[];
  /** Forwarded to {@link AttachmentPreviewModal} so it can lazily fetch
   *  attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
}

/**
 * How many attachment squares render inline before the strip collapses.
 * A message with more than this many attachments shows the first
 * VISIBLE_LIMIT squares plus one overflow tile.
 */
const VISIBLE_LIMIT = 5;

/**
 * Read-only strip of attachment thumbnails rendered as a separate strip for
 * assistant messages (the user path now renders attachments inside the message
 * bubble via {@link BubbleAttachments}). Every attachment is clickable and
 * opens a full-screen preview modal — the modal handles type-specific
 * rendering (image/video/fallback) and lazily fetches missing content when
 * needed. A hover overlay on each square provides direct download without
 * opening the preview first.
 */
export const MessageAttachments: FC<MessageAttachmentsProps> = ({
  attachments,
  assistantId,
}) => {
  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    attachments,
  );

  const handleDownload = useCallback(
    (att: DisplayAttachment) => {
      void downloadAttachment(att, assistantId);
    },
    [assistantId],
  );

  if (attachments.length === 0) {
    return null;
  }

  const visible = attachments.slice(0, VISIBLE_LIMIT);
  const overflowCount = attachments.length - visible.length;

  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        {visible.map((att) => (
          <MessageAttachmentSquare
            key={att.id}
            filename={att.filename}
            mimeType={att.mimeType}
            sizeBytes={att.sizeBytes}
            previewUrl={att.previewUrl}
            thumbnailUrl={att.thumbnailUrl}
            onPreview={() => openPreview(att)}
            onDownload={() => handleDownload(att)}
          />
        ))}
        {overflowCount > 0 && (
          <AttachmentOverflowSquare
            count={overflowCount}
            onClick={() => openPreview(attachments[VISIBLE_LIMIT]!)}
          />
        )}
      </div>
      {previewModal}
    </>
  );
};
