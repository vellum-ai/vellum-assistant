import { windowAttentionPayloadSchema } from "@vellumai/ipc-contract";
import type { WindowAttentionPayload } from "@vellumai/ipc-contract";

import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's window attention bridge.
 * Vellum windows set `backgroundThrottling: false`, which also disables the
 * Page Visibility API, so `document.visibilityState` is pinned to `"visible"`
 * in the desktop renderer and `visibilitychange` never fires. Only the main
 * process can say whether the window is on screen, and it pushes that state
 * here.
 *
 * Each payload describes the window this renderer runs in, never another one.
 * A conversation pop-out is its own window, so it reads its own visibility
 * rather than the main window's.
 *
 * Off Electron this is a no-op returning an unsubscribe-noop: the browser and
 * the iOS shell read the same fact from the DOM through
 * `runtime/event-sources/dom-visibility.ts`.
 *
 * The bridge is optional because a renderer can run against a desktop shell
 * that predates the channel, in which case no payload ever arrives and the
 * caller decides what an unknown window state means.
 *
 * The payload crosses an IPC boundary, so it is validated against the
 * contract schema. One that fails validation is delivered as `null` rather
 * than guessed at, so the caller can pick the direction that notifies over
 * the one that suppresses.
 *
 * This module also owns the synchronous reads of the same fact,
 * {@link isWindowAttended} and {@link isVisibleToUser}, because the
 * cross-platform branch belongs in the capability wrapper (`docs/ELECTRON.md`)
 * and the last reported state is what both answer from.
 */

/** Last reported attention state, `null` before the first payload. */
let attended: boolean | null = null;

/**
 * Whether a reported window state means the user can see this window and is
 * working in it. A payload the contract could not read counts as unattended,
 * for the reason {@link isWindowAttended} gives.
 */
export function isAttendedPayload(
  payload: WindowAttentionPayload | null,
): boolean {
  return payload !== null
    ? payload.visible && payload.focused && !payload.minimized
    : false;
}

export function subscribeToWindowAttention(
  callback: (payload: WindowAttentionPayload | null) => void,
): () => void {
  if (!isElectron()) {
    return () => undefined;
  }
  const unsubscribe =
    window.vellum?.notifications?.onWindowAttention?.((payload) => {
      const parsed = windowAttentionPayloadSchema.safeParse(payload);
      const next = parsed.success ? parsed.data : null;
      attended = isAttendedPayload(next);
      callback(next);
    }) ?? (() => undefined);
  return () => {
    attended = null;
    unsubscribe();
  };
}

/**
 * Whether the desktop window is on screen, unminimized, and focused.
 *
 * Off Electron this is `true`: the signal never fires there, the DOM is the
 * authority, and a `false` would veto every consumer that gates on attention.
 * Under Electron a missing answer resolves to `false` instead, because the
 * only ways to get one are a host that predates the channel and a payload the
 * contract cannot read. Both mean the renderer does not know where the window
 * is, and a consumer suppressing a notification on the strength of that would
 * drop it for good.
 *
 * The desktop's read. Anything asking "can the user see this client" across
 * platforms wants {@link isVisibleToUser}, which is this read in the desktop
 * renderer and the DOM's everywhere else.
 */
export function isWindowAttended(): boolean {
  if (attended !== null) {
    return attended;
  }
  return !isElectron();
}

/**
 * Whether this client is on screen for the user, on every platform.
 *
 * Under Electron that is the main process's window report rather than the
 * DOM, which cannot answer it there. In a browser tab and in the Capacitor
 * shell the DOM is the authority, and `document.visibilityState` is the
 * existing contract for whether a conversation is on screen:
 * `document.hasFocus()` is window-level and false for a visible tab in an
 * unfocused browser window, which is not the same question.
 *
 * The one predicate every "is the user watching this" consumer asks. Reading
 * {@link isWindowAttended} directly instead answers `true` for a hidden
 * browser tab, since no payload ever arrives there.
 */
export function isVisibleToUser(): boolean {
  if (isElectron()) {
    return isWindowAttended();
  }
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}
