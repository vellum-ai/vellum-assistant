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
 */
export function subscribeToWindowAttention(
  callback: (payload: WindowAttentionPayload | null) => void,
): () => void {
  if (!isElectron()) {
    return () => undefined;
  }
  return (
    window.vellum?.notifications?.onWindowAttention?.((payload) => {
      const parsed = windowAttentionPayloadSchema.safeParse(payload);
      callback(parsed.success ? parsed.data : null);
    }) ?? (() => undefined)
  );
}
