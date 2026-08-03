/**
 * Side-drawer panel listing every attachment on one transcript message.
 * Opened by the overflow tile on a truncated attachment strip (see
 * `MessageAttachments`). Each tile opens the shared full-screen preview
 * modal with gallery navigation across the whole set.
 *
 * Streams live: the panel re-derives the message's attachments from the
 * transcript by `messageId` via `useLiveMessageAttachments`, so files that
 * land mid-turn appear while the panel is open. The payload's embedded
 * snapshot is the fallback for the one case the live source cannot answer -
 * the message having been paged out of the loaded transcript.
 */

import { Paperclip } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { DetailShell } from "@/components/detail-shell";
import { useAttachmentSquares } from "@/domains/chat/components/chat-attachments/use-attachment-squares";
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
  const { displayAttachments, renderSquare, previewModal } =
    useAttachmentSquares({
      attachments,
      assistantId: payload.assistantId,
    });

  return (
    <DetailShell
      Glyph={Paperclip}
      // Matches the activity-steps panel header: title · N inline at the same
      // size, separated by a 3px midline dot, count in the secondary tone.
      titleNode={
        <span className="flex min-w-0 items-center gap-1.5 py-0.5">
          <Typography
            variant="title-medium"
            className="min-w-0 shrink truncate leading-snug text-[var(--content-default)]"
          >
            Files
          </Typography>
          <span
            aria-hidden
            className="size-[3px] shrink-0 rounded-full bg-[var(--content-tertiary)]"
          />
          <Typography
            variant="title-medium"
            className="shrink-0 whitespace-nowrap leading-snug text-[var(--content-secondary)]"
          >
            {displayAttachments.length}
          </Typography>
        </span>
      }
      closeLabel="Close files"
      onClose={onClose}
    >
      {displayAttachments.length === 0 ? (
        <Typography
          variant="body-small-default"
          className="py-4 text-center text-[var(--content-tertiary)]"
        >
          No files on this message
        </Typography>
      ) : (
        // Wraps rather than sitting on a fixed column count: the drawer is
        // drag-resizable and the mobile overlay renders this same panel at
        // full viewport width. `items-start` keeps squares with taller
        // captions from stretching their neighbours.
        <div className="flex flex-wrap items-start gap-3">
          {displayAttachments.map((att, index) => renderSquare(att, index))}
        </div>
      )}
      {previewModal}
    </DetailShell>
  );
}
