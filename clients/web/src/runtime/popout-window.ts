import { isElectron } from "@/runtime/is-electron";

/**
 * Request the Electron host to open (or focus) a pop-out window for the given
 * conversation. No-ops on web and Capacitor iOS where pop-out windows don't
 * exist. Also no-ops gracefully on older Electron shells that predate the
 * popout channel.
 */
export async function openPopoutWindow(conversationId: string): Promise<void> {
  if (!isElectron()) {
    return;
  }
  await window.vellum?.popout?.open(conversationId);
}
