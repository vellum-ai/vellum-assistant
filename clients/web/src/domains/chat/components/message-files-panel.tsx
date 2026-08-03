/**
 * Side-drawer panel listing every attachment on one transcript message.
 * Opened by the overflow tile on a truncated attachment strip (see
 * `MessageAttachments`). Each tile opens the shared full-screen preview
 * modal with gallery navigation across the whole set.
 *
 * Streams live: the panel re-derives the message's attachments from the
 * transcript by `messageId` via `useLiveMessageAttachments`, so files that
 * land mid-turn appear while the panel is open. The payload's embedded
 * snapshot is the fallback when the message can't be resolved (paged out, or
 * identity-less callers like stories).
 */

import { Paperclip } from "lucide-react";

import { DetailShell } from "@/components/detail-shell";
import { downloadAttachment } from "@/domains/chat/components/chat-attachments/download-attachment";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import { useLiveMessageAttachments } from "@/domains/chat/hooks/use-live-message-attachments";
import type { MessageFilesPayload } from "@/stores/viewer-store";

interface MessageFilesPanelProps {
  payload: MessageFilesPayload;
  onClose: () => void;
}

export function MessageFilesPanel({
  payload,
  onClose,
}: MessageFilesPanelProps) {
  const live = useLiveMessageAttachments(payload.messageId);
  const attachments = live ?? payload.attachments;
  const { openPreview, previewModal } = useAttachmentPreview(
    payload.assistantId,
    attachments,
  );

  return (
    <DetailShell
      Glyph={Paperclip}
      title={`Files · ${attachments.length}`}
      closeLabel="Close files"
      onClose={onClose}
    >
      {/* Three across fits the drawer's 400px default width. */}
      <div className="grid grid-cols-3 gap-3">
        {attachments.map((att) => (
          <MessageAttachmentSquare
            key={att.id}
            filename={att.filename}
            mimeType={att.mimeType}
            sizeBytes={att.sizeBytes}
            previewUrl={att.previewUrl}
            thumbnailUrl={att.thumbnailUrl}
            onPreview={() => openPreview(att)}
            onDownload={() => void downloadAttachment(att, payload.assistantId)}
          />
        ))}
      </div>
      {previewModal}
    </DetailShell>
  );
}
