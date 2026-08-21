import { Typography } from "@vellumai/design-library";

import { ATTACHMENT_TILE_BOX_CLASS } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import {
  sameMessageFilesTarget,
  useViewerStore,
  type MessageFilesPayload,
} from "@/stores/viewer-store";
import { useTranslation } from "@/i18n";

interface AttachmentOverflowSquareProps {
  /** How many attachments are hidden behind this tile. */
  count: number;
  /** The files-panel target this tile opens, closes, and reflects. */
  payload: MessageFilesPayload;
}

/**
 * Terminal tile of a truncated attachment strip. Stands in for the
 * attachments past the inline limit, and toggles the files side panel that
 * lists all of them.
 *
 * The viewer-store reads live here rather than in {@link MessageAttachments}
 * because this tile mounts only on the minority of strips that actually
 * overflow. Reading `mainView` one level up would subscribe EVERY assistant
 * attachment strip in the transcript to a global, reference-equality slice, so
 * opening any overlay anywhere would re-render all of them.
 */
export function AttachmentOverflowSquare({
  count,
  payload,
}: AttachmentOverflowSquareProps) {
  const { t } = useTranslation("chat");
  const toggleMessageFiles = useViewerStore.use.toggleMessageFiles();
  const mainView = useViewerStore.use.mainView();
  const activeMessageFiles = useViewerStore.use.activeMessageFiles();

  // The tile whose files panel is currently open renders with the persistent
  // active surface, mirroring the activity group header's selected state.
  const active =
    mainView === "message-files" &&
    activeMessageFiles != null &&
    sameMessageFilesTarget(activeMessageFiles, payload);

  return (
    <button
      type="button"
      onClick={() => toggleMessageFiles(payload)}
      aria-label={t("attachmentOverflowSquare.showAllAria", { count })}
      aria-expanded={active}
      title={t("attachmentOverflowSquare.moreTitle", { count })}
      className={`${ATTACHMENT_TILE_BOX_CLASS} flex items-center justify-center border border-dashed transition-colors ${
        active
          ? "border-[var(--border-active)] bg-[var(--surface-lift)]"
          : "border-[var(--border-element)] hover:bg-[var(--surface-lift)]"
      }`}
    >
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
      >
        +{count}
      </Typography>
    </button>
  );
}
