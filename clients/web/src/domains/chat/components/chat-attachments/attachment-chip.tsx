import { X } from "lucide-react";
import type { FC, MouseEventHandler } from "react";

import { useTranslation } from "@/i18n";

import { Button } from "@vellumai/design-library";

import {
  ATTACHMENT_ICON_BY_KIND,
  classifyAttachment,
  middleTruncate,
} from "@/domains/chat/components/chat-attachments/utils";

interface AttachmentChipProps {
  id: string;
  filename: string;
  mimeType: string;
  previewUrl: string | null;
  onRemove: (id: string) => void;
  /** Called when the user clicks an image chip to open a full-screen preview. */
  onPreview?: () => void;
  /** Called when the browser cannot decode the preview. Lets the owner drop
   *  the thumbnail for the kind icon. */
  onPreviewError?: () => void;
  /** The composer's press guard for the remove control. */
  pressGuard?: MouseEventHandler<HTMLElement>;
}

export const AttachmentChip: FC<AttachmentChipProps> = ({
  id,
  filename,
  mimeType,
  previewUrl,
  onRemove,
  onPreview,
  onPreviewError,
  pressGuard,
}) => {
  const { t } = useTranslation("chat");
  const kind = classifyAttachment(mimeType, filename);
  const Icon = ATTACHMENT_ICON_BY_KIND[kind];
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
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-lift)] text-[var(--content-secondary)]"
      >
        {hasPreview ? (
          // A real <img> rather than a CSS background so an undecodable
          // preview raises `onError` and the owner can fall back to the icon.
          <img
            src={previewUrl}
            alt=""
            draggable={false}
            onError={onPreviewError}
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon className="h-4 w-4" />
        )}
      </div>
      <span className="min-w-0 max-w-[156px] truncate text-body-small-default leading-4 text-[var(--content-secondary)]">
        {displayName}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <div className="h-8 w-px shrink-0 bg-[var(--border-disabled)]" />
        <Button
          variant="ghost"
          size="compact"
          expandOnMobile={false}
          iconOnly={<X />}
          onMouseDown={pressGuard}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(id);
          }}
          aria-label={t("attachmentChip.removeAria", { filename })}
        />
      </div>
    </div>
  );
};
