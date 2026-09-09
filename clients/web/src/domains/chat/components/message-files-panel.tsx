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

import {
  DetailShell,
  DetailShellNotice,
  DetailShellTitleWithCount,
} from "@/components/detail-shell";
import { useAttachmentSquares } from "@/domains/chat/components/chat-attachments/use-attachment-squares";
import { useLiveMessageAttachments } from "@/domains/chat/hooks/use-live-message-attachments";
import { useTranslation } from "@/i18n";
import type { MessageFilesPayload } from "@/stores/viewer-store";

interface MessageFilesPanelProps {
  payload: MessageFilesPayload;
  onClose: () => void;
}

export function MessageFilesPanel({
  payload,
  onClose,
}: MessageFilesPanelProps) {
  const { t } = useTranslation("chat");
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
      titleNode={
        <DetailShellTitleWithCount
          title={t("messageFilesPanel.title")}
          count={displayAttachments.length}
        />
      }
      closeLabel={t("messageFilesPanel.closeAria")}
      onClose={onClose}
    >
      {displayAttachments.length === 0 ? (
        <DetailShellNotice>{t("messageFilesPanel.empty")}</DetailShellNotice>
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
