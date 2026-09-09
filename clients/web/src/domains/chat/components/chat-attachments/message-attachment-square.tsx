import type { MouseEvent } from "react";
import { useCallback } from "react";

import { Typography } from "@vellumai/design-library";
import { AttachmentDownloadOverlay } from "@/domains/chat/components/chat-attachments/attachment-download-overlay";
import { AttachmentPreviewBox } from "@/domains/chat/components/chat-attachments/attachment-preview-box";

import {
  classifyAttachment,
  formatAttachmentSize,
  middleTruncate,
} from "@/domains/chat/components/chat-attachments/utils";
import type { DisplayAttachment } from "@/domains/chat/types/types";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { cn } from "@/utils/misc";

/**
 * Geometry of the square's inner tile box. Shared with
 * {@link AttachmentOverflowSquare} so the terminal overflow tile lines up with
 * the squares it sits beside - the two must stay identical or the strip breaks.
 */
export const ATTACHMENT_TILE_BOX_CLASS = "h-16 w-16 shrink-0 rounded-lg";

interface MessageAttachmentSquareProps {
  attachment: DisplayAttachment;
  /** Called when the user clicks the thumbnail to open a full-screen preview. */
  onPreview?: () => void;
  /** Called when the user clicks a download button. */
  onDownload?: () => void;
  /** Called when the browser fails to decode the image preview (e.g. a HEIC
   *  blob on a Chromium renderer). Lets the owner null the dead `previewUrl`
   *  so this square falls back to its file-kind icon. */
  onPreviewError?: () => void;
}

/**
 * Square thumbnail used inside message bubbles. Image attachments render their
 * preview edge-to-edge; non-image attachments fall back to a neutral surface
 * with an icon. On hover, a download overlay appears at the bottom-right of
 * the thumbnail.
 */
export function MessageAttachmentSquare({
  attachment,
  onPreview,
  onDownload,
  onPreviewError,
}: MessageAttachmentSquareProps) {
  const { filename, mimeType, sizeBytes, previewUrl, thumbnailUrl } =
    attachment;
  const kind = classifyAttachment(mimeType, filename);
  const hasImagePreview = kind === "image" && previewUrl !== null;
  const backgroundImageUrl =
    kind === "video" && thumbnailUrl != null ? thumbnailUrl : null;
  // With nothing filling the tile, its `--surface-lift` fill disappears on a
  // container painted the same colour (the files panel's `DetailShell` body),
  // leaving a bare glyph. A `--border-element` hairline is the one outline that
  // reads against both `--surface-base` and `--surface-lift` in every theme.
  const showsIcon = !hasImagePreview && backgroundImageUrl === null;
  const isClickable = onPreview != null;
  const displayName = middleTruncate(filename, 18);
  const displaySize = formatAttachmentSize(sizeBytes);
  const isNative = useIsNativePlatform();

  const handleDownloadClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      onDownload?.();
    },
    [onDownload],
  );

  return (
    <div
      role={isClickable ? "button" : hasImagePreview ? "img" : undefined}
      aria-label={filename}
      title={filename}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? onPreview : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPreview?.();
              }
            }
          : undefined
      }
      data-reveal-row=""
      className={`group flex flex-col gap-1${isClickable ? " cursor-pointer" : ""}`}
    >
      <div className="relative w-fit">
        <AttachmentPreviewBox
          className={cn(
            ATTACHMENT_TILE_BOX_CLASS,
            "bg-[var(--surface-lift)]",
            showsIcon && "border border-[var(--border-element)]",
          )}
          kind={kind}
          imageUrl={hasImagePreview ? previewUrl : null}
          posterUrl={backgroundImageUrl}
          onImageError={onPreviewError}
          glyphClassName="h-6 w-6"
        />
        {onDownload && (
          <AttachmentDownloadOverlay
            filename={filename}
            onDownload={handleDownloadClick}
            className="rounded-lg"
          />
        )}
      </div>
      <Typography
        variant="label-small-default"
        className="max-w-[64px] truncate text-[var(--content-tertiary)]"
      >
        {displayName}
      </Typography>
      {/* The file size adds noise on the narrow native layout, so the native
          shell hides it; web/electron keep it. */}
      {!isNative && (
        <Typography
          variant="label-small-default"
          className="text-[var(--content-disabled)]"
        >
          {displaySize}
        </Typography>
      )}
    </div>
  );
}
