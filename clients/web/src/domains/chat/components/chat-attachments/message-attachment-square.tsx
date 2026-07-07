
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
import type { FC, MouseEvent, ReactNode } from "react";
import { useCallback } from "react";

import { Tooltip, Typography } from "@vellumai/design-library";

import {
    classifyAttachment,
    formatAttachmentSize,
    middleTruncate,
    type AttachmentIconKind,
} from "@/domains/chat/components/chat-attachments/utils";
import { useIsNativePlatform } from "@/runtime/native-auth";

interface MessageAttachmentSquareProps {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string | null;
  /** Called when the user clicks the thumbnail to open a full-screen preview. */
  onPreview?: () => void;
  /** Called when the user clicks a download button. */
  onDownload?: () => void;
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
export const MessageAttachmentSquare: FC<MessageAttachmentSquareProps> = ({
  filename,
  mimeType,
  sizeBytes,
  previewUrl,
  onPreview,
  onDownload,
}) => {
  const kind = classifyAttachment(mimeType, filename);
  const hasImagePreview = kind === "image" && previewUrl !== null;
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
          className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-lift)] bg-cover bg-center text-[var(--content-secondary)]"
          style={
            hasImagePreview
              ? { backgroundImage: `url(${JSON.stringify(previewUrl)})` }
              : undefined
          }
        >
          {hasImagePreview ? null : ICON_BY_KIND[kind]}
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
      {/* iOS-only simplification (Figma review, node 6638-6731): the file
          size adds noise on the narrow native layout. Web/electron keep it. */}
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
};
