import { AlertCircle, Folder, Paperclip, X } from "lucide-react";
import type { ChangeEvent, FC } from "react";
import { useCallback, useRef, useState } from "react";

import { Button } from "@vellumai/design-library";

import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { AttachmentChip } from "@/domains/chat/components/chat-attachments/attachment-chip";
import { AttachmentLoadingChip } from "@/domains/chat/components/chat-attachments/attachment-loading-chip";
import { AttachmentPreviewModal } from "@/domains/chat/components/chat-attachments/attachment-preview-modal";
import type {
  ChatAttachment,
  UploadedAttachment,
} from "@/domains/chat/composer-store";
import { middleTruncate } from "@/domains/chat/components/chat-attachments/utils";

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
  const [previewAttachment, setPreviewAttachment] =
    useState<UploadedAttachment | null>(null);
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
                onCancel={onRemove}
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
                  onClick={() => onRemove(att.localId)}
                  aria-label={`Remove ${att.filename}`}
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
  onFilesSelected: (files: FileList) => void;
  /** Tooltip override; defaults to "Attach file" when unset. */
  title?: string;
}

/**
 * Paperclip button that triggers a hidden file input. Lives in the lower-left
 * of the composer action bar to match the macOS layout.
 *
 * On iOS (Capacitor WKWebView), clicking the hidden `<input type="file">`
 * presents the native document/photo picker, which resigns the web view's
 * first responder — dismissing the soft keyboard and collapsing the
 * keyboard-aware layout (`root-layout.tsx` sizes the shell from
 * `visualViewport`). The native picker and the keyboard are mutually
 * exclusive first responders, so the keyboard cannot stay up *during* the
 * picker. Instead we re-focus the composer the moment the picker closes —
 * on both file-select (`handleChange`) and cancel (which does not fire
 * `change`, so we arm a one-shot window `focus`/`visibilitychange` listener).
 * `requestComposerFocus()` is idempotent and a no-op on desktop (the textarea
 * is already focused there and the OS file dialog doesn't steal focus), so the
 * refocus is safe to run unconditionally.
 */
export const AttachFileButton: FC<AttachFileButtonProps> = ({
  disabled = false,
  onFilesSelected,
  title = "Attach file",
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleClick = useCallback(() => {
    // Arm a one-shot listener so a *cancelled* picker (which fires no
    // `change` event) still restores the keyboard when the web view regains
    // first responder. `focus` and `visibilitychange` both fire when the
    // native modal dismisses; whichever lands first refocuses and disarms.
    const restore = () => {
      window.removeEventListener("focus", restore);
      document.removeEventListener("visibilitychange", onVisible);
      requestComposerFocus();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        restore();
      }
    };
    window.addEventListener("focus", restore, { once: true });
    document.addEventListener("visibilitychange", onVisible);

    inputRef.current?.click();
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files && files.length > 0) {
        onFilesSelected(files);
      }
      // Reset so selecting the same file twice still fires onChange.
      event.target.value = "";
      // Restore the keyboard/layout after the picker closes on selection.
      // (The cancel path is handled by the one-shot listener in handleClick.)
      requestComposerFocus();
    },
    [onFilesSelected],
  );

  return (
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
  );
};
