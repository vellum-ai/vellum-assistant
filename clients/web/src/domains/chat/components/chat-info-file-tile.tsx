/**
 * One file in the Chat Info panel: a daemon document, a message attachment, or
 * a camera frame. Documents and non-image attachments show their kind's glyph;
 * an image shows its picture, fetched only once the tile is on screen.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";

import { DocumentAssetActions } from "@/domains/chat/components/conversation-asset-actions";
import { useAttachmentObjectUrl } from "@/domains/chat/components/chat-attachments/use-attachment-object-url";
import {
  ATTACHMENT_ICON_BY_KIND,
  classifyAttachment,
} from "@/domains/chat/components/chat-attachments/utils";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import { useTranslation } from "@/i18n";
import { formatFriendlyDate } from "@/utils/format-date";

/** Fixed tile width, and what the section fits a row of them to. Kept in step with `w-[135px]` below. */
export const CHAT_INFO_FILE_TILE_WIDTH_PX = 135;

/** Stands in for a document's absent attachment so the bytes hook stays unconditional. */
const NO_ATTACHMENT = { id: "", previewUrl: null };

export interface ChatInfoFileTileProps {
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

  // A browser without IntersectionObserver loads every tile rather than none:
  // the picture is the tile's content here, not an enhancement of it.
  const [isVisible, setIsVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const attachment = file.kind === "document" ? null : file.attachment;
  // A document's own glyph is the `document` kind's, so the three kinds of tile
  // share one lookup rather than branching on which one this is.
  const kind = attachment
    ? classifyAttachment(attachment.mimeType, attachment.filename)
    : "document";

  const [previewFailed, setPreviewFailed] = useState(false);
  const { url, isError } = useAttachmentObjectUrl(
    assistantId,
    attachment ?? NO_ATTACHMENT,
    isVisible && kind === "image",
  );

  // Video posters stay a CSS background: there is no fallback to swap to when
  // a poster fails, so an <img> would surface the browser's broken glyph.
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
      ? formatFriendlyDate(new Date(file.capturedAt))
      : file.title;

  const renderBoxContent = () => {
    if (kind === "image" && !previewFailed) {
      if (url) {
        return (
          <img
            src={url}
            alt=""
            aria-hidden
            className="h-full w-full object-cover"
            onError={() => setPreviewFailed(true)}
          />
        );
      }
      if (!isError) {
        return (
          <Loader2 className="size-8 animate-spin text-[var(--content-tertiary)]" />
        );
      }
    }
    if (posterUrl) {
      return null;
    }
    const Icon = ATTACHMENT_ICON_BY_KIND[kind];
    return <Icon className="size-8" />;
  };

  return (
    <div
      data-reveal-row=""
      className="relative flex w-[135px] shrink-0 flex-col gap-1"
    >
      <button
        ref={boxRef}
        type="button"
        aria-label={ariaLabel}
        onClick={() => onOpen(file)}
        style={
          posterUrl
            ? { backgroundImage: `url(${JSON.stringify(posterUrl)})` }
            : undefined
        }
        className="relative flex h-[84px] w-full cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-base)] bg-cover bg-center text-[var(--content-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        {renderBoxContent()}
      </button>

      {/* Attachments and frames carry no menu: the preview modal already offers Download. */}
      {file.kind === "document" ? (
        <span data-reveal="" className="absolute right-1 top-1">
          <DocumentAssetActions
            assistantId={assistantId}
            doc={file.doc}
            onOpen={() => onOpen(file)}
          />
        </span>
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
