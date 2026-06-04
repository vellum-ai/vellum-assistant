
import {
    Archive,
    Code2,
    FileAudio,
    File as FileIcon,
    FileImage,
    FileSpreadsheet,
    FileText,
    FileType2,
    FileVideo,
} from "lucide-react";
import type { FC, ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import {
    classifyAttachment,
    formatAttachmentSize,
    middleTruncate,
    type AttachmentIconKind,
} from "@/domains/chat/components/chat-attachments/utils";

interface MessageAttachmentSquareProps {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string | null;
  /** Called when the user clicks the thumbnail to open a full-screen preview. */
  onPreview?: () => void;
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
 * Square thumbnail used inside sent user message bubbles. Image attachments
 * render their preview edge-to-edge; non-image attachments fall back to a
 * neutral surface with an icon. The filename and size render below the
 * thumbnail so users can identify what they sent without opening a preview.
 */
export const MessageAttachmentSquare: FC<MessageAttachmentSquareProps> = ({
  filename,
  mimeType,
  sizeBytes,
  previewUrl,
  onPreview,
}) => {
  const kind = classifyAttachment(mimeType, filename);
  const hasImagePreview = kind === "image" && previewUrl !== null;
  const isClickable = onPreview != null;
  const displayName = middleTruncate(filename, 18);
  const displaySize = formatAttachmentSize(sizeBytes);

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
      className={`flex flex-col gap-1${isClickable ? " cursor-pointer" : ""}`}
    >
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
      <Typography
        variant="label-small-default"
        className="max-w-[64px] truncate text-[var(--content-tertiary)]"
      >
        {displayName}
      </Typography>
      <Typography
        variant="label-small-default"
        className="text-[var(--content-disabled)]"
      >
        {displaySize}
      </Typography>
    </div>
  );
};
