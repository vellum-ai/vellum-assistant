
import { AlertCircle, FolderUp, Paperclip } from "lucide-react";
import type { ChangeEvent, FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@vellum/design-library";

import { AttachmentChip } from "@/domains/chat/components/chat-attachments/attachment-chip";
import { AttachmentLoadingChip } from "@/domains/chat/components/chat-attachments/attachment-loading-chip";
import { AttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-preview-modal";
import { filterFolderFiles } from "@/domains/chat/components/chat-attachments/folder-files";
import type { ChatAttachment, UploadedAttachment } from "@/domains/chat/components/chat-attachments/use-chat-attachments";
import { formatAttachmentSize, middleTruncate } from "@/domains/chat/components/chat-attachments/utils";

interface ChatAttachmentsStripProps {
  attachments: ChatAttachment[];
  onRemove: (localId: string) => void;
}

/**
 * Horizontally-scrollable strip of attachment chips rendered above the composer
 * input. Mirrors the macOS `ComposerAttachments` strip layout.
 */
export const ChatAttachmentsStrip: FC<ChatAttachmentsStripProps> = ({
  attachments,
  onRemove,
}) => {
  const [previewAttachment, setPreviewAttachment] = useState<UploadedAttachment | null>(null);
  const handleClosePreview = useCallback(() => setPreviewAttachment(null), []);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex gap-2 overflow-x-auto px-3 pb-1.5 pt-2 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {attachments.map((att) => {
          if (att.kind === "uploading") {
            return (
              <AttachmentLoadingChip
                key={att.localId}
                localId={att.localId}
                filename={att.filename}
                sizeBytes={att.sizeBytes}
                onCancel={onRemove}
              />
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
                <span className="min-w-0 truncate text-body-small-default">
                  {middleTruncate(att.filename)}
                </span>
                <span className="shrink-0 text-body-small-default opacity-70">·</span>
                <span className="shrink-0 text-body-small-default opacity-70">
                  {formatAttachmentSize(att.sizeBytes)}
                </span>
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => onRemove(att.localId)}
                  aria-label={`Remove ${att.filename}`}
                  className="ml-0.5 underline"
                >
                  Dismiss
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
              sizeBytes={att.sizeBytes}
              previewUrl={att.previewUrl}
              onRemove={onRemove}
              onPreview={() => setPreviewAttachment(att)}
            />
          );
        })}
      </div>
      {previewAttachment && (
        <AttachmentPreviewModal
          open
          onClose={handleClosePreview}
          attachment={previewAttachment}
        />
      )}
    </>
  );
};

interface AttachFileButtonProps {
  disabled?: boolean;
  onFilesSelected: (files: FileList | File[]) => void;
  /** Tooltip override; defaults to "Attach file" when unset. */
  title?: string;
  /**
   * When true (default), render a second button that opens a directory picker
   * so the user can attach an entire folder at once. The folder's files are
   * filtered (junk dirs/files removed, count capped) before being forwarded to
   * `onFilesSelected`.
   */
  enableFolderUpload?: boolean;
}

/**
 * Paperclip button that triggers a hidden file input, plus an optional folder
 * button that opens a directory picker. Lives in the lower-left of the composer
 * action bar to match the macOS layout.
 */
export const AttachFileButton: FC<AttachFileButtonProps> = ({
  disabled = false,
  onFilesSelected,
  title = "Attach file",
  enableFolderUpload = true,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // `webkitdirectory` is a non-standard attribute that React/TS won't accept as
  // a JSX prop, so set it imperatively on the hidden folder input once mounted.
  useEffect(() => {
    const input = folderInputRef.current;
    if (input) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    }
  }, []);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFolderClick = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files && files.length > 0) {
        onFilesSelected(files);
      }
      // Reset so selecting the same file twice still fires onChange.
      event.target.value = "";
    },
    [onFilesSelected],
  );

  const handleFolderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files && files.length > 0) {
        // The directory picker returns every descendant file; drop noise and
        // cap the count before staging uploads.
        const { accepted } = filterFolderFiles(Array.from(files));
        if (accepted.length > 0) {
          onFilesSelected(accepted);
        }
      }
      event.target.value = "";
    },
    [onFilesSelected],
  );

  return (
    <>
      <div className="relative">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="absolute inset-0 opacity-0 pointer-events-none"
          onChange={handleChange}
          aria-hidden="true"
          tabIndex={-1}
        />
        <Button
          variant="ghost"
          iconOnly={<Paperclip />}
          onClick={handleClick}
          disabled={disabled}
          aria-label="Attach file"
          title={title}
          className="[--vbtn-fg:var(--content-secondary)]"
        />
      </div>
      {enableFolderUpload && (
        <div className="relative">
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="absolute inset-0 opacity-0 pointer-events-none"
            onChange={handleFolderChange}
            aria-hidden="true"
            tabIndex={-1}
          />
          <Button
            variant="ghost"
            iconOnly={<FolderUp />}
            onClick={handleFolderClick}
            disabled={disabled}
            aria-label="Attach folder"
            title={disabled ? title : "Attach folder"}
            className="[--vbtn-fg:var(--content-secondary)]"
          />
        </div>
      )}
    </>
  );
};
