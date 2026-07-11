import { AlertCircle, Folder, Paperclip, X } from "lucide-react";
import type { ChangeEvent, FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

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
 * picker. Instead we re-focus the composer the moment the picker closes,
 * keyed off the file input's own events so the signal is tied to the picker
 * (not to app foregrounding, which also fires when the app is backgrounded
 * and returned to while the picker is still open):
 *
 * - `change` — a file was selected.
 * - `cancel` — the picker was dismissed without a selection (WebKit / Safari
 *   16.4+). Precise: tied to the picker dismissal itself.
 * - one-shot `window` `focus` — fallback for iOS 15–16.3 WKWebViews (the app's
 *   deployment target is iOS 15) that predate the `cancel` event. Armed on
 *   picker open and removed after firing once, so a later real `cancel` on
 *   newer engines still works and the fallback can't linger. `focus` fires
 *   when the web view regains first responder as the picker closes.
 *
 * `requestComposerFocus()` is idempotent and a no-op on desktop (the textarea
 * is already focused there and the OS file dialog doesn't steal focus), so
 * running it from more than one of these paths is harmless.
 */
export const AttachFileButton: FC<AttachFileButtonProps> = ({
  disabled = false,
  onFilesSelected,
  title = "Attach file",
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Cleanup for the armed iOS 15–16.3 focus fallback (see handleClick). Held
  // in a ref so every picker-close path (change, cancel, unmount) can disarm
  // it, not just a window focus event.
  const disarmFocusFallbackRef = useRef<(() => void) | null>(null);

  const refocusComposer = useCallback(() => {
    // Any picker-close path lands here: disarm the pending focus fallback so it
    // can't fire on a later unrelated window focus, then restore the keyboard.
    disarmFocusFallbackRef.current?.();
    disarmFocusFallbackRef.current = null;
    requestComposerFocus();
  }, []);

  const handleClick = useCallback(() => {
    // Fallback for iOS 15–16.3 WKWebViews that don't fire the input `cancel`
    // event: refocus the composer the first time the window regains focus
    // after the picker opens (the picker resigned it). On iOS 16.4+ the
    // `cancel`/`change` paths fire first and disarm this via refocusComposer,
    // so it never lingers past the picker session.
    disarmFocusFallbackRef.current?.();
    const onFocus = () => refocusComposer();
    window.addEventListener("focus", onFocus, { once: true });
    disarmFocusFallbackRef.current = () =>
      window.removeEventListener("focus", onFocus);
    inputRef.current?.click();
  }, [refocusComposer]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files && files.length > 0) {
        onFilesSelected(files);
      }
      // Reset so selecting the same file twice still fires onChange.
      event.target.value = "";
      // Restore the keyboard/layout after the picker closes on selection.
      refocusComposer();
    },
    [onFilesSelected, refocusComposer],
  );

  // Cancel path: the native picker fires `cancel` (not `change`) when
  // dismissed without a selection. Refocusing here restores the keyboard
  // without relying on app-foreground signals, which would misfire if the app
  // is backgrounded and resumed while the picker is still open. Attached
  // imperatively because the installed React typings don't yet expose the
  // `onCancel` prop for `<input>` (the DOM event exists in WebKit 16.4+). The
  // effect cleanup also disarms any pending focus fallback on unmount.
  useEffect(() => {
    const input = inputRef.current;
    const onCancel = () => refocusComposer();
    input?.addEventListener("cancel", onCancel);
    return () => {
      input?.removeEventListener("cancel", onCancel);
      disarmFocusFallbackRef.current?.();
      disarmFocusFallbackRef.current = null;
    };
  }, [refocusComposer]);

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
