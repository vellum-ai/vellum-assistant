import type { ChangeEvent, ReactElement } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  /**
   * Restore the composer's focus on close whatever held it when the picker
   * opened. For a caller that takes focus itself on the way to the picker: the
   * add-to-chat sheet traps focus, so the open-time sample would always read
   * "nothing to put back" and the sheet would stop returning a keyboard it
   * returns today.
   */
  alwaysRestoreFocus?: boolean;
}

interface UseAttachmentFilePickerResult {
  /** Opens the native picker and arms the iOS focus fallback. */
  openPicker: () => void;
  /** Hidden `<input type="file">` the caller must render. */
  inputNode: ReactElement;
  /**
   * True from the moment the picker is opened until it closes. The native
   * picker takes the web view's first responder, which on iOS arrives in the
   * DOM as the composer losing focus, so a caller that gates layout on its own
   * focus has to hold that gate open for this instead.
   */
  pickerOpen: boolean;
}

/**
 * Owns a hidden `<input type="file">` and the composer refocus that has to run
 * whenever the native picker closes. Callers render `inputNode` and call
 * `openPicker()` from their own trigger.
 *
 * On iOS (Capacitor WKWebView), clicking the hidden `<input type="file">`
 * presents the native document/photo picker, and WebKit resigns the web
 * view's first responder to do it: `WKFileUploadPanel.mm` resigns in the
 * completion handlers of both the file menu's display animation and the
 * picker's presentation. The keyboard therefore cannot stay up during the
 * picker, and no input attribute, plugin call or config reaches that decision.
 *
 * The way back is a DOM focus: `Keyboard.show()` is Android only, while the
 * Capacitor shell disables `keyboardShouldRequireUserInteraction`, so
 * focusing the textarea raises the keyboard with no gesture.
 *
 * Close signals, in order of precision:
 *
 * - `change`: a file was selected.
 * - `cancel`: the picker was dismissed without a selection (WebKit / Safari
 *   16.4+). Precise: tied to the picker dismissal itself.
 * - one-shot `window` `focus`: for engines predating `cancel`, and armed off
 *   the native iOS shell only. That shell builds against iOS 17 and WKWebView
 *   tracks the OS, so `cancel` is always there; arming this too would add a
 *   close signal that also fires on plain app foregrounding, ending the
 *   session while the picker is still on screen.
 *
 */
export function useAttachmentFilePicker({
  onFiles,
  multiple = false,
  accept,
  capture,
  alwaysRestoreFocus = false,
}: UseAttachmentFilePickerOptions): UseAttachmentFilePickerResult {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The picker's own lifetime, which outlives the composer's focus: presenting
  // it dismisses the keyboard, and `useComposerFocusWithin` reads that dismiss
  // as focus returning to the body. Without this the composer would rearrange
  // itself for an idle composer while the picker it opened is still up.
  const [pickerOpen, setPickerOpen] = useState(false);
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
    setPickerOpen(false);
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
    setPickerOpen(true);
    inputRef.current?.click();
  }, [alwaysRestoreFocus, refocusComposer]);

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

  return { openPicker, inputNode, pickerOpen };
}
