import type { ChangeEvent, ReactElement } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { requestComposerFocus } from "@/domains/chat/composer-focus";

interface UseAttachmentFilePickerOptions {
  /** Receives the picked files. Not called when the picker closes empty. */
  onFiles: (files: FileList) => void;
  /** Allow picking more than one file. */
  multiple?: boolean;
  /** `accept` attribute for the input, e.g. `"image/*"`. */
  accept?: string;
  /** `capture` attribute, e.g. `"environment"` for the rear camera. */
  capture?: boolean | "user" | "environment";
}

interface UseAttachmentFilePickerResult {
  /** Opens the native picker and arms the iOS focus fallback. */
  openPicker: () => void;
  /** Hidden `<input type="file">` the caller must render. */
  inputNode: ReactElement;
}

/**
 * Owns a hidden `<input type="file">` and the composer refocus that has to run
 * whenever the native picker closes. Callers render `inputNode` and call
 * `openPicker()` from their own trigger.
 *
 * On iOS (Capacitor WKWebView), clicking the hidden `<input type="file">`
 * presents the native document/photo picker, which resigns the web view's
 * first responder, dismissing the soft keyboard and collapsing the
 * keyboard-aware layout (`root-layout.tsx` sizes the shell from
 * `visualViewport`). The native picker and the keyboard are mutually
 * exclusive first responders, so the keyboard cannot stay up *during* the
 * picker. Instead we re-focus the composer the moment the picker closes,
 * keyed off the file input's own events so the signal is tied to the picker
 * (not to app foregrounding, which also fires when the app is backgrounded
 * and returned to while the picker is still open):
 *
 * - `change`: a file was selected.
 * - `cancel`: the picker was dismissed without a selection (WebKit / Safari
 *   16.4+). Precise: tied to the picker dismissal itself.
 * - one-shot `window` `focus`: fallback for iOS 15 through 16.3 WKWebViews
 *   (the app's deployment target is iOS 15) that predate the `cancel` event.
 *   Armed on picker open and removed after firing once, so a later real
 *   `cancel` on newer engines still works and the fallback can't linger.
 *   `focus` fires when the web view regains first responder as the picker
 *   closes.
 *
 * `requestComposerFocus()` is idempotent and a no-op on desktop (the textarea
 * is already focused there and the OS file dialog doesn't steal focus), so
 * running it from more than one of these paths is harmless.
 */
export function useAttachmentFilePicker({
  onFiles,
  multiple = false,
  accept,
  capture,
}: UseAttachmentFilePickerOptions): UseAttachmentFilePickerResult {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Kept in a ref so an unmemoized caller callback doesn't remint `inputNode`,
  // which would remount the input mid-picker for consumers that render it.
  const onFilesRef = useRef(onFiles);
  useLayoutEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  // Cleanup for the armed iOS 15 through 16.3 focus fallback (see openPicker).
  // Held in a ref so every picker-close path (change, cancel, unmount) can
  // disarm it, not just a window focus event.
  const disarmFocusFallbackRef = useRef<(() => void) | null>(null);

  const refocusComposer = useCallback(() => {
    // Any picker-close path lands here: disarm the pending focus fallback so it
    // can't fire on a later unrelated window focus, then restore the keyboard.
    disarmFocusFallbackRef.current?.();
    disarmFocusFallbackRef.current = null;
    requestComposerFocus();
  }, []);

  const openPicker = useCallback(() => {
    // Fallback for iOS 15 through 16.3 WKWebViews that don't fire the input
    // `cancel` event: refocus the composer the first time the window regains
    // focus after the picker opens (the picker resigned it). On iOS 16.4+ the
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
        onFilesRef.current(files);
      }
      // Reset so selecting the same file twice still fires onChange.
      event.target.value = "";
      // Restore the keyboard/layout after the picker closes on selection.
      refocusComposer();
    },
    [refocusComposer],
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

  const inputNode = useMemo(
    () => (
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        capture={capture}
        className="absolute inset-0 opacity-0 pointer-events-none"
        onChange={handleChange}
        aria-hidden="true"
        tabIndex={-1}
      />
    ),
    [multiple, accept, capture, handleChange],
  );

  return { openPicker, inputNode };
}
