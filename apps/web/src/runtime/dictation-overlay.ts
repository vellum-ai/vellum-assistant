/**
 * Runtime wrapper for the dictation overlay bridge surface.
 *
 * The Electron main process owns a system-wide, click-through panel pinned
 * top-center of the active display that shows the user's words live while
 * they dictate via push-to-talk into another app (the Electron port of the
 * native Swift client's `DictationOverlayWindow`).
 *
 * Feature code imports these functions instead of touching
 * `window.vellum.dictationOverlay` directly. Off-Electron (web, Capacitor
 * iOS) and on older shells that predate the channel they are no-ops, so the
 * dictation flow degrades gracefully.
 */

import {
  isElectron,
  type DictationOverlayMessage,
  type DictationOverlayState,
} from "@/runtime/is-electron";

/**
 * Publish the current dictation lifecycle state to the overlay.
 * Fire-and-forget — interim transcription updates are high-frequency.
 */
export function setDictationOverlayState(
  state: DictationOverlayMessage,
): void {
  if (!isElectron()) return;
  window.vellum?.dictationOverlay?.setState(state);
}

/**
 * Subscribe to overlay states. Only the dictation overlay window's own
 * renderer route consumes this. Returns an unsubscribe function.
 */
export function subscribeToDictationOverlayState(
  callback: (state: DictationOverlayState) => void,
): () => void {
  if (!isElectron() || !window.vellum?.dictationOverlay) {
    return () => undefined;
  }
  return window.vellum.dictationOverlay.onState(callback);
}

/**
 * Read the latest overlay state (null when no session is active, off
 * Electron, or on shells that predate the channel). The overlay route
 * loads lazily, so states pushed before its subscription registers are
 * dropped — pull this once subscribed to catch up.
 */
export async function getDictationOverlayState(): Promise<DictationOverlayState | null> {
  if (!isElectron() || !window.vellum?.dictationOverlay?.getState) {
    return null;
  }
  return window.vellum.dictationOverlay.getState();
}

/**
 * Ask main to stop the active dictation session — the overlay's stop
 * button. Main relays it to the recording session's renderer as a
 * `stopDictation` command.
 */
export function requestDictationOverlayStop(): void {
  if (!isElectron()) return;
  window.vellum?.dictationOverlay?.requestStop?.();
}

/**
 * Toggle the overlay window between click-through (default) and
 * interactive. The overlay page flips it interactive only while the
 * cursor is over the stop button, so the transparent canvas around the
 * pill never swallows clicks meant for the app underneath.
 */
export function setDictationOverlayInteractive(interactive: boolean): void {
  if (!isElectron()) return;
  window.vellum?.dictationOverlay?.setInteractive?.(interactive);
}
