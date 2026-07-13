import {
  AlertCircle,
  Camera,
  Folder,
  Image as ImageIcon,
  Paperclip,
  X,
} from "lucide-react";
import type { ChangeEvent, FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Menu } from "@vellumai/design-library";

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

/** A selectable attachment source rendered as a row in the menu. */
type AttachSource = "library" | "camera" | "files";

/**
 * Paperclip button in the lower-left of the composer action bar (matches the
 * macOS layout). Opens a Vellum-styled {@link Menu} of attachment sources
 * anchored to the button; picking a source triggers that source's hidden
 * `<input type="file">`, which presents the native picker.
 *
 * ## Why our own menu instead of the bare file input
 *
 * A plain `<input type="file">` on iOS opens the *native* action sheet
 * (Photo Library / Take Photo / Choose File). That sheet is drawn by the OS
 * and its position is not ours to control — WKWebView gives no hook to anchor
 * it to the paperclip, so it renders wherever iOS decides (and, once the soft
 * keyboard collapses, visibly detached from the button that launched it).
 *
 * Rendering our own menu puts positioning back under our control: it anchors
 * above the paperclip (`side="top"`) via the design-library `Menu`, matching
 * the composer settings menu. Radix positions it against the trigger and
 * repositions on viewport/scroll changes, so it stays pinned to the button
 * even as the keyboard collapses. Choosing a source then opens that source's
 * native picker (the OS still owns *that* surface).
 *
 * ## Keyboard restore after the picker closes
 *
 * Presenting the native picker resigns the web view's first responder, so the
 * soft keyboard drops while the picker is up — an OS constraint with no web
 * workaround. Once the picker closes we re-focus the composer, keyed off the
 * file input's own events so the signal is tied to the picker (not to app
 * foregrounding, which also fires if the app is backgrounded and resumed while
 * the picker is still open):
 *
 * - `change` — a file was selected.
 * - `cancel` — the picker was dismissed without a selection (WebKit / Safari
 *   16.4+). Tied precisely to the picker dismissal.
 *
 * iOS 15–16.3 predates the `cancel` event, so on those engines a *cancelled*
 * picker won't auto-restore the keyboard — the user taps the composer to bring
 * it back. A previous implementation used a one-shot `window` `focus` fallback
 * for those engines, but it fired on *any* window focus (app foregrounding,
 * dismissing an unrelated overlay) and popped the keyboard back up on unrelated
 * taps, so it was removed. Leaving the keyboard down until an explicit tap is
 * strictly better than re-raising it on the wrong event.
 *
 * `requestComposerFocus()` is idempotent and a no-op on desktop.
 */
export const AttachFileButton: FC<AttachFileButtonProps> = ({
  disabled = false,
  onFilesSelected,
  title = "Attach file",
}) => {
  // One input per source. `library`/`camera` narrow to images (and, for
  // `camera`, request the capture device); `files` is unrestricted.
  const libraryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);

  const inputRefFor = useCallback((source: AttachSource) => {
    switch (source) {
      case "library":
        return libraryInputRef;
      case "camera":
        return cameraInputRef;
      case "files":
        return filesInputRef;
    }
  }, []);

  const openSource = useCallback(
    (source: AttachSource) => {
      inputRefFor(source).current?.click();
    },
    [inputRefFor],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { files } = event.target;
      if (files && files.length > 0) {
        onFilesSelected(files);
      }
      // Reset so selecting the same file twice still fires onChange.
      event.target.value = "";
      // Restore the keyboard/layout after the picker closes on selection.
      requestComposerFocus();
    },
    [onFilesSelected],
  );

  // Cancel path: the native picker fires `cancel` (not `change`) when
  // dismissed without a selection (WebKit 16.4+). Refocusing here restores the
  // keyboard without relying on app-foreground signals, which would misfire if
  // the app is backgrounded and resumed while the picker is still open.
  // Attached imperatively because the installed React typings don't expose an
  // `onCancel` prop for `<input>`. Registered on every source input.
  useEffect(() => {
    const inputs = [
      libraryInputRef.current,
      cameraInputRef.current,
      filesInputRef.current,
    ];
    const onCancel = () => requestComposerFocus();
    for (const input of inputs) {
      input?.addEventListener("cancel", onCancel);
    }
    return () => {
      for (const input of inputs) {
        input?.removeEventListener("cancel", onCancel);
      }
    };
  }, []);

  const hiddenInputClassName = "absolute inset-0 opacity-0 pointer-events-none";

  return (
    <div className="relative">
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        multiple
        className={hiddenInputClassName}
        onChange={handleChange}
        aria-hidden="true"
        tabIndex={-1}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className={hiddenInputClassName}
        onChange={handleChange}
        aria-hidden="true"
        tabIndex={-1}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className={hiddenInputClassName}
        onChange={handleChange}
        aria-hidden="true"
        tabIndex={-1}
      />
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button
            variant="ghost"
            iconOnly={<Paperclip />}
            disabled={disabled}
            aria-label="Attach file"
            title={title}
            className="[--vbtn-fg:var(--content-secondary)]"
          />
        </Menu.Trigger>
        <Menu.Content side="top" align="start">
          <Menu.Item
            onSelect={() => openSource("library")}
            leftIcon={<ImageIcon className="h-3.5 w-3.5" />}
          >
            Photo Library
          </Menu.Item>
          <Menu.Item
            onSelect={() => openSource("camera")}
            leftIcon={<Camera className="h-3.5 w-3.5" />}
          >
            Take Photo
          </Menu.Item>
          <Menu.Item
            onSelect={() => openSource("files")}
            leftIcon={<Folder className="h-3.5 w-3.5" />}
          >
            Choose Files
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
    </div>
  );
};
