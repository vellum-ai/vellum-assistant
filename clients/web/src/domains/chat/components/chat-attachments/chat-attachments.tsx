import { AlertCircle, Folder, Paperclip, X } from "lucide-react";
import type { FC, MouseEventHandler } from "react";
import { useMemo } from "react";
import { useTranslation } from "@/i18n";

import { Button, cn } from "@vellumai/design-library";

import { AttachmentChip } from "@/domains/chat/components/chat-attachments/attachment-chip";
import { AttachmentLoadingChip } from "@/domains/chat/components/chat-attachments/attachment-loading-chip";
import { AttachmentTile } from "@/domains/chat/components/chat-attachments/attachment-tile";
import { useAttachmentFilePicker } from "@/domains/chat/components/chat-attachments/use-attachment-file-picker";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import { useFailedPreviewIds } from "@/domains/chat/components/chat-attachments/use-failed-preview-ids";
import type {
  ChatAttachment,
  UploadedAttachment,
} from "@/domains/chat/composer-store";
import {
  classifyAttachment,
  middleTruncate,
} from "@/domains/chat/components/chat-attachments/utils";

interface ChatAttachmentsStripProps {
  attachments: ChatAttachment[];
  onRemove: (localId: string) => void;
  /**
   * Render images as square tiles instead of chips. The tile drops the
   * filename, so it only suits a surface where the picture identifies the
   * attachment on its own.
   */
  tileImages?: boolean;
  /** The composer's press guard, worn by every control the strip renders. */
  pressGuard?: MouseEventHandler<HTMLElement>;
}

/**
 * Whether the strip shows this attachment as a tile: an image that is either
 * still uploading or already carries a decodable preview. Anything else keeps
 * the chip, which is the only place its filename or its error shows.
 */
function isTiledImage(att: ChatAttachment): boolean {
  if (att.kind !== "uploading" && att.kind !== "uploaded") {
    return false;
  }
  if (att.kind === "uploaded" && att.previewUrl === null) {
    return false;
  }
  return classifyAttachment(att.mimeType, att.filename) === "image";
}

/**
 * Horizontally-scrollable strip of attachment chips rendered above the composer
 * input. Mirrors the macOS `ComposerAttachments` strip layout.
 */
export const ChatAttachmentsStrip: FC<ChatAttachmentsStripProps> = ({
  attachments,
  onRemove,
  tileImages = false,
  pressGuard,
}) => {
  const { t } = useTranslation("chat");
  // A preview the browser could not decode (a TIFF, or a HEIF whose conversion
  // fell back) would tile as a blank square with no filename, so it drops back
  // to the chip and its kind icon.
  const { failedIds, markFailed } = useFailedPreviewIds();
  // Render from the sanitized list rather than the input, so a URL already
  // known to be dead reaches neither the strip nor the lightbox.
  const displayAttachments = useMemo(
    () =>
      failedIds.size === 0
        ? attachments
        : attachments.map((att) =>
            att.kind === "uploaded" && failedIds.has(att.localId)
              ? { ...att, previewUrl: null }
              : att,
          ),
    [attachments, failedIds],
  );
  // Every finished upload is a gallery sibling, so the lightbox arrows move
  // between the attached photos instead of opening one at a time. Composer
  // previews are inline blob URLs, so the modal needs no assistant to fetch
  // from.
  const uploadedAttachments = useMemo(
    () =>
      displayAttachments.filter(
        (att): att is UploadedAttachment => att.kind === "uploaded",
      ),
    [displayAttachments],
  );
  const { openPreview, previewModal } = useAttachmentPreview(
    null,
    uploadedAttachments,
  );

  if (attachments.length === 0) {
    return null;
  }

  // A chip beside a tile keeps its own height rather than stretching to the
  // tile's. A row with no tile in it is all one height, so it stretches.
  const hasTile = tileImages && displayAttachments.some(isTiledImage);

  return (
    <>
      <div
        className={cn(
          "flex gap-2 overflow-x-auto px-3 pb-1.5 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]",
          // The card insets its content 12px on mobile, against the 8px a
          // desktop chip row takes.
          tileImages ? "pt-3" : "pt-2",
          hasTile && "items-start",
        )}
      >
        {displayAttachments.map((att) => {
          if (tileImages && isTiledImage(att)) {
            const uploaded = att.kind === "uploaded" ? att : null;
            return (
              <AttachmentTile
                key={att.localId}
                id={att.localId}
                filename={att.filename}
                previewUrl={uploaded?.previewUrl ?? null}
                onRemove={onRemove}
                onPreview={() => {
                  if (uploaded) {
                    openPreview(uploaded);
                  }
                }}
                onPreviewError={() => markFailed(att.localId)}
                pressGuard={pressGuard}
              />
            );
          }
          if (att.kind === "uploading") {
            return (
              <AttachmentLoadingChip
                key={att.localId}
                localId={att.localId}
                filename={att.filename}
                onCancel={onRemove}
                pressGuard={pressGuard}
              />
            );
          }
          if (att.kind === "path-reference") {
            return (
              <div
                key={att.localId}
                className="flex max-w-[280px] shrink-0 items-center gap-2 rounded-lg bg-[var(--surface-base)] py-1 pl-2 pr-1"
                title={att.path}
              >
                <Folder className="h-4 w-4 shrink-0 text-[var(--content-secondary)]" />
                <div className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate text-body-small-default leading-4 text-[var(--content-secondary)]">
                    {middleTruncate(att.filename)}
                  </span>
                  <span className="min-w-0 truncate text-label-small-default leading-3 text-[var(--content-tertiary)]">
                    {middleTruncate(att.path)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="compact"
                  expandOnMobile={false}
                  iconOnly={<X />}
                  onMouseDown={pressGuard}
                  onClick={() => onRemove(att.localId)}
                  aria-label={t("chatAttachments.removeAria", { filename: att.filename })}
                />
              </div>
            );
          }
          if (att.kind === "failed") {
            return (
              <div
                key={att.localId}
                className="flex max-w-[280px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--system-negative-strong)]/40 bg-[var(--system-negative-strong)]/10 py-1 pl-2 pr-1.5 text-[var(--system-negative-strong)]"
                title={att.error}
              >
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate text-body-small-default leading-4">
                  {middleTruncate(att.filename)}
                </span>
                <Button
                  variant="ghost"
                  size="compact"
                  onMouseDown={pressGuard}
                  onClick={() => onRemove(att.localId)}
                  aria-label={t("chatAttachments.removeAria", { filename: att.filename })}
                  className="ml-0.5 underline"
                >
                  {t("chatAttachments.dismiss")}
                </Button>
              </div>
            );
          }

          return (
            <AttachmentChip
              key={att.localId}
              id={att.localId}
              filename={att.filename}
              mimeType={att.mimeType}
              previewUrl={att.previewUrl}
              onRemove={onRemove}
              onPreview={() => openPreview(att)}
              onPreviewError={() => markFailed(att.localId)}
              pressGuard={pressGuard}
            />
          );
        })}
      </div>
      {previewModal}
    </>
  );
};

interface AttachFileButtonProps {
  disabled?: boolean;
  onFilesSelected: (files: FileList) => void;
  /** Tooltip override; defaults to "Attach file" when unset. */
  title?: string;
}

/**
 * Paperclip button that triggers a hidden file input. Lives in the lower-left
 * of the composer action bar to match the macOS layout. The input itself and
 * the iOS keyboard-refocus dance it depends on live in
 * `useAttachmentFilePicker`.
 */
export const AttachFileButton: FC<AttachFileButtonProps> = ({
  disabled = false,
  onFilesSelected,
  title,
}) => {
  const { t } = useTranslation("chat");
  const resolvedTitle = title ?? t("chatAttachments.attachFileAria");
  const { openPicker, inputNode } = useAttachmentFilePicker({
    onFiles: onFilesSelected,
    multiple: true,
  });

  return (
    <div className="relative">
      {inputNode}
      <Button
        variant="ghost"
        iconOnly={<Paperclip />}
        onClick={openPicker}
        disabled={disabled}
        aria-label={t("chatAttachments.attachFileAria")}
        title={resolvedTitle}
        // Tertiary resting tone, matching the composer action row's icons
        // (Figma: New-App 7471-25234). The touch-mobile override beats the
        // ghost icon-only variant's default-tone mobile chrome so mobile
        // matches desktop.
        className="[--vbtn-fg:var(--content-tertiary)] touch-mobile:[--vbtn-fg:var(--content-tertiary)]"
      />
    </div>
  );
};
