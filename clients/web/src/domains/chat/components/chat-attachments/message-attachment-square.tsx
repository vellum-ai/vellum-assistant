import {
  Archive,
  Code2,
  Download,
  FileAudio,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useCallback } from "react";

import { Tooltip, Typography } from "@vellumai/design-library";

import {
  classifyAttachment,
  formatAttachmentSize,
  middleTruncate,
  type AttachmentIconKind,
} from "@/domains/chat/components/chat-attachments/utils";
import type { DisplayAttachment } from "@/domains/chat/types/types";
import { useIsNativePlatform } from "@/runtime/native-auth";

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

const ICON_BY_KIND: Record<AttachmentIconKind, ReactNode> = {
  image: <FileImage className="h-6 w-6" />,
  video: <FileVideo className="h-6 w-6" />,
  audio: <FileAudio className="h-6 w-6" />,
  pdf: <FileType2 className="h-6 w-6" />,
  code: <Code2 className="h-6 w-6" />,
  archive: <Archive className="h-6 w-6" />,
  spreadsheet: <FileSpreadsheet className="h-6 w-6" />,
  document: <FileText className="h-6 w-6" />,
  text: <FileText className="h-6 w-6" />,
  file: <FileIcon className="h-6 w-6" />,
};

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
  // Video posters stay a CSS background: there is no fallback to swap to when
  // a poster fails, so an <img> would surface the browser's broken glyph.
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
      className={`group/square flex flex-col gap-1${isClickable ? " cursor-pointer" : ""}`}
    >
      <div className="relative w-fit">
        <div
          className={`${ATTACHMENT_TILE_BOX_CLASS} flex items-center justify-center overflow-hidden bg-[var(--surface-lift)] bg-cover bg-center text-[var(--content-secondary)]${showsIcon ? " border border-[var(--border-element)]" : ""}`}
          style={
            backgroundImageUrl
              ? {
                  backgroundImage: `url(${JSON.stringify(backgroundImageUrl)})`,
                }
              : undefined
          }
        >
          {hasImagePreview ? (
            // A real <img> rather than a CSS background so an undecodable
            // preview raises `onError` and the owner can fall back to the icon.
            <img
              src={previewUrl}
              alt=""
              aria-hidden
              onError={onPreviewError}
              className="h-full w-full object-cover"
            />
          ) : backgroundImageUrl ? null : (
            ICON_BY_KIND[kind]
          )}
        </div>
        {onDownload && (
          <div className="pointer-events-none absolute inset-0 rounded-lg bg-black/50 opacity-0 transition-opacity group-hover/square:pointer-events-auto group-hover/square:opacity-100 group-focus-within/square:pointer-events-auto group-focus-within/square:opacity-100">
            <Tooltip content="Download">
              <button
                type="button"
                onClick={handleDownloadClick}
                onKeyDown={(e) => e.stopPropagation()}
                aria-label={`Download ${filename}`}
                className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
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
