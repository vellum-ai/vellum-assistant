import { useCallback, useMemo } from "react";
import type { FC } from "react";

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { AttachmentOverflowSquare } from "@/domains/chat/components/chat-attachments/attachment-overflow-square";
import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import {
  sameMessageFilesTarget,
  useViewerStore,
  type MessageFilesPayload,
} from "@/stores/viewer-store";

interface MessageAttachmentsProps {
  attachments: DisplayAttachment[];
  /** Forwarded to {@link AttachmentPreviewModal} so it can lazily fetch
   *  attachment content when `previewUrl` is missing. */
  assistantId?: string | null;
  /** Transcript message identity, forwarded to the files panel payload. */
  messageId?: string;
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
 * opening the preview first. Past {@link VISIBLE_LIMIT} the strip collapses
 * behind an overflow tile that opens the files side panel.
 */
export const MessageAttachments: FC<MessageAttachmentsProps> = ({
  attachments,
  assistantId,
  messageId,
}) => {
  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    attachments,
  );
  const toggleMessageFiles = useViewerStore.use.toggleMessageFiles();
  const mainView = useViewerStore.use.mainView();
  const activeMessageFiles = useViewerStore.use.activeMessageFiles();

  const handleDownload = useCallback(
    (att: DisplayAttachment) => {
      void downloadAttachment(att, assistantId);
    },
    [assistantId],
  );

  const filesPayload: MessageFilesPayload = useMemo(
    () => ({ messageId, attachments, assistantId }),
    [messageId, attachments, assistantId],
  );

  // The tile whose files panel is currently open renders with the persistent
  // active surface, mirroring the activity group header's selected state.
  const tileActive =
    mainView === "message-files" &&
    activeMessageFiles != null &&
    sameMessageFilesTarget(activeMessageFiles, filesPayload);

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
            active={tileActive}
            onClick={() => toggleMessageFiles(filesPayload)}
          />
        )}
      </div>
      {previewModal}
    </>
  );
};
