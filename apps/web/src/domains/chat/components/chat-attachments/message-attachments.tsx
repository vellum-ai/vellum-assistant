
import { useCallback, useState } from "react";
import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/utils/reconcile.js";

import { AttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-preview-modal.js";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square.js";

interface MessageAttachmentsProps {
  attachments: DisplayAttachment[];
  /** Forwarded to {@link AttachmentPreviewModal} so it can lazily fetch
   *  attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
}

/**
 * Read-only strip of attachment thumbnails rendered inside a sent user message
 * bubble. Every attachment is clickable and opens a full-screen preview modal
 * — the modal handles type-specific rendering (image/video/fallback) and
 * lazily fetches missing content when needed.
 */
export const MessageAttachments: FC<MessageAttachmentsProps> = ({
  attachments,
  assistantId,
}) => {
  const [previewAttachment, setPreviewAttachment] = useState<DisplayAttachment | null>(null);

  const handleClose = useCallback(() => setPreviewAttachment(null), []);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {attachments.map((att) => (
          <MessageAttachmentSquare
            key={att.id}
            filename={att.filename}
            mimeType={att.mimeType}
            sizeBytes={att.sizeBytes}
            previewUrl={att.previewUrl}
            onPreview={() => setPreviewAttachment(att)}
          />
        ))}
      </div>
      {previewAttachment && (
        <AttachmentPreviewModal
          open
          onClose={handleClose}
          attachment={previewAttachment}
          assistantId={assistantId}
        />
      )}
    </>
  );
};
