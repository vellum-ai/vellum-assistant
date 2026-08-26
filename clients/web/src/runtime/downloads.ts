import { isElectron } from "@/runtime/is-electron";
import type { DownloadDoneEvent } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's download-outcome bridge.
 * Matches the shape in `power-events.ts`: feature code never touches
 * `window.vellum.*` directly, and the cross-platform branch lives here.
 *
 * Off Electron (web build, Capacitor iOS/Android) both functions are no-ops:
 * a browser download is handed to the browser's own download UI, and a
 * Capacitor "download" is a share sheet, so neither host has a completion
 * signal to subscribe to or a saved path to reveal. The same is true on an
 * Electron shell whose preload predates the `downloads` surface.
 *
 * The bus integration in `use-event-bus-init` calls
 * `subscribeToDownloadEvents` once at mount and republishes each report as a
 * `download.done` bus event; `use-download-feedback` is the one consumer and
 * owns the resulting toasts.
 */

export type { DownloadDoneEvent };

export function subscribeToDownloadEvents(
  callback: (event: DownloadDoneEvent) => void,
): () => void {
  if (!isElectron()) {
    return () => undefined;
  }
  return window.vellum?.downloads?.onDone(callback) ?? (() => undefined);
}

/**
 * Reveal a completed download in the host's file manager. `id` comes from a
 * `"completed"` `DownloadDoneEvent`; the main process resolves it to the
 * saved path itself and ignores ids it never issued.
 */
export async function revealDownload(id: string): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.downloads?.reveal(id);
}
