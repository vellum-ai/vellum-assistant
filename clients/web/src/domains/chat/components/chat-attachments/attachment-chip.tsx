
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
    X,
} from "lucide-react";
import type { FC, ReactNode } from "react";

import { Button } from "@vellumai/design-library";

import {
    classifyAttachment,
    middleTruncate,
    type AttachmentIconKind,
} from "@/domains/chat/components/chat-attachments/utils";

interface AttachmentChipProps {
  id: string;
  filename: string;
  mimeType: string;
  previewUrl: string | null;
  /** When omitted, the chip renders in read-only mode (no remove button).
   *  This lets the same chip be reused inside sent user message bubbles. */
  onRemove?: (id: string) => void;
  /** Called when the user clicks an image chip to open a full-screen preview. */
  onPreview?: () => void;
}

const ICON_BY_KIND: Record<AttachmentIconKind, ReactNode> = {
  image: <FileImage className="h-4 w-4" />,
  video: <FileVideo className="h-4 w-4" />,
  audio: <FileAudio className="h-4 w-4" />,
  pdf: <FileType2 className="h-4 w-4" />,
  code: <Code2 className="h-4 w-4" />,
  archive: <Archive className="h-4 w-4" />,
  spreadsheet: <FileSpreadsheet className="h-4 w-4" />,
  document: <FileText className="h-4 w-4" />,
  text: <FileText className="h-4 w-4" />,
  file: <FileIcon className="h-4 w-4" />,
};

export const AttachmentChip: FC<AttachmentChipProps> = ({
  id,
  filename,
  mimeType,
  previewUrl,
  onRemove,
  onPreview,
}) => {
  const kind = classifyAttachment(mimeType, filename);
  const displayName = middleTruncate(filename);
  const hasPreview = kind === "image" && previewUrl !== null;
  const isClickable = hasPreview && onPreview != null;

  return (
    <div
      className={`flex shrink-0 items-center gap-3 rounded-lg bg-[var(--surface-base)] py-1 pl-1 pr-2${isClickable ? " cursor-pointer" : ""}`}
      title={filename}
      role={isClickable ? "button" : undefined}
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
    >
      <div
        role={hasPreview ? "img" : undefined}
        aria-label={hasPreview ? filename : undefined}
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-lift)] bg-cover bg-center text-[var(--content-secondary)]"
        style={
          hasPreview && previewUrl
            ? { backgroundImage: `url(${JSON.stringify(previewUrl)})` }
            : undefined
        }
      >
        {hasPreview ? null : ICON_BY_KIND[kind]}
      </div>
      <span className="min-w-0 max-w-[156px] truncate text-body-small-default leading-4 text-[var(--content-secondary)]">
        {displayName}
      </span>
      {onRemove ? (
        <div className="flex shrink-0 items-center gap-2">
          <div className="h-8 w-px shrink-0 bg-[var(--border-disabled)]" />
          <Button
            variant="ghost"
            size="compact"
            expandOnMobile={false}
            iconOnly={<X />}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(id);
            }}
            aria-label={`Remove ${filename}`}
          />
        </div>
      ) : null}
    </div>
  );
};
