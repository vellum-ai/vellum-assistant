import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Registers a document-level `keydown` listener that cancels the active
 * assistant action when Escape is pressed — but only when cancellation is
 * possible and no modal/dialog is currently consuming the Escape key.
 *
 * This covers the "app is focused" half of the global Escape cancel
 * feature. The "app is unfocused" half is handled by the Electron main
 * process escape monitor (`apps/macos/src/main/escape-monitor.ts`) which
 * dispatches a `cancelActiveAction` command over IPC.
 *
 * The listener uses the bubbling phase and yields to modals/dialogs:
 * if the event target is inside a `[role="dialog"]` or
 * `[role="alertdialog"]` element, the handler no-ops so the dialog can
 * close normally on Escape.
 */
export function useEscapeCancel(
  canStopGenerating: boolean,
  onCancel: () => void,
): void {
  const canStopRef = useRef(canStopGenerating);
  const onCancelRef = useRef(onCancel);

  useLayoutEffect(() => {
    canStopRef.current = canStopGenerating;
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      if (!canStopRef.current) {
        return;
      }

      // Yield to open dialogs — Escape should close them, not cancel
      // the assistant action.
      const target = event.target as Element | null;
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) {
        return;
      }

      // Yield if another handler already consumed the event.
      if (event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      onCancelRef.current();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
