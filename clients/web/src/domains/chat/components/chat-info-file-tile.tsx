/**
 * One file in the Chat Info panel: a daemon document, a message attachment, or
 * a camera frame. Documents and non-image attachments show their kind's glyph;
 * an image shows its picture, fetched and held only while the tile is on
 * screen.
 */

import { Loader2 } from "lucide-react";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

import {
  AssetActionsSlot,
  DocumentAssetActions,
} from "@/domains/chat/components/conversation-asset-actions";
import { AttachmentPreviewBox } from "@/domains/chat/components/chat-attachments/attachment-preview-box";
import { useAttachmentObjectUrl } from "@/domains/chat/components/chat-attachments/use-attachment-object-url";
import { classifyAttachment } from "@/domains/chat/components/chat-attachments/utils";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import { useInView } from "@/hooks/use-in-view";
import { useTranslation } from "@/i18n";
import { formatCaptureTime } from "@/utils/format-date";

/** Fixed tile width, and what the section fits a row of them to. */
export const CHAT_INFO_FILE_TILE_WIDTH_PX = 135;

const TILE_STYLE: CSSProperties = { width: CHAT_INFO_FILE_TILE_WIDTH_PX };

interface ChatInfoFileTileProps {
  file: ConversationFileAsset;
  assistantId: string;
  onOpen: (file: ConversationFileAsset) => void;
}

export function ChatInfoFileTile({
  file,
  assistantId,
  onOpen,
}: ChatInfoFileTileProps) {
  const { t } = useTranslation("chat");
  const boxRef = useRef<HTMLButtonElement>(null);

  const isOnScreen = useInView(boxRef);
  // A browser without IntersectionObserver loads every tile rather than none:
  // the picture is the tile's content here, not an enhancement of it.
  const isVisible = isOnScreen || typeof IntersectionObserver === "undefined";

  const attachment = file.kind === "document" ? null : file.attachment;
  // A document's own glyph is the `document` kind's, so the three kinds of tile
  // share one lookup rather than branching on which one this is.
  const kind = attachment
    ? classifyAttachment(attachment.mimeType, attachment.filename)
    : "document";

  const [previewFailed, setPreviewFailed] = useState(false);
  const { url, isError } = useAttachmentObjectUrl(
    assistantId,
    attachment,
    isVisible && kind === "image",
  );

  const posterUrl =
    kind === "video" && attachment?.thumbnailUrl != null
      ? attachment.thumbnailUrl
      : null;

  let ariaLabel: string;
  if (file.kind === "document") {
    ariaLabel = t("chatInfoPanel.openDocumentAria", { name: file.title });
  } else if (file.kind === "frame") {
    ariaLabel = t("chatInfoPanel.previewFrameAria");
  } else {
    ariaLabel = t("chatInfoPanel.previewAttachmentAria", {
      filename: file.attachment.filename,
    });
  }

  const label =
    file.kind === "frame" && file.capturedAt !== null
      ? formatCaptureTime(file.capturedAt)
      : file.title;

  const showsImage = kind === "image" && !previewFailed;

  return (
    <div
      data-slot="chat-info-file-tile"
      data-reveal-row=""
      className="relative flex shrink-0 flex-col gap-1"
      style={TILE_STYLE}
    >
      <button
        ref={boxRef}
        type="button"
        aria-label={ariaLabel}
        onClick={() => onOpen(file)}
        className="block h-[84px] w-full cursor-pointer overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <AttachmentPreviewBox
          className="h-full w-full rounded-lg bg-[var(--surface-base)]"
          kind={kind}
          imageUrl={showsImage ? url : null}
          posterUrl={posterUrl}
          onImageError={() => setPreviewFailed(true)}
          glyphClassName="size-8"
          placeholder={
            showsImage && !isError ? (
              <Loader2 className="size-8 animate-spin text-[var(--content-tertiary)]" />
            ) : null
          }
        />
      </button>

      {/* Attachments and frames carry no menu: the preview modal already offers Download. */}
      {file.kind === "document" ? (
        <AssetActionsSlot>
          <DocumentAssetActions
            assistantId={assistantId}
            doc={file.doc}
            onOpen={() => onOpen(file)}
          />
        </AssetActionsSlot>
      ) : null}

      <Typography
        variant="body-small-default"
        title={label}
        className="truncate text-[var(--content-tertiary)]"
      >
        {label}
      </Typography>
    </div>
  );
}
