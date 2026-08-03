/**
 * Resolves "which app is the user looking at right now?" for outgoing
 * messages.
 *
 * The daemon renders the reported id as the `visible_app:` line of the
 * assistant's per-turn context, so a message sent while an app is on screen
 * carries the app with it and the assistant can act on "make the header
 * bigger" without asking which app. It is context only: nothing in the UI
 * changes, and the id is omitted whenever no app is in view.
 *
 * Read live at send time (like the effective timezone) rather than captured
 * when the composer mounts, so opening or closing an app between keystrokes is
 * reflected on the next send.
 */

import { useViewerStore } from "@/stores/viewer-store";

/**
 * The app currently on screen, or `undefined` when the viewer is showing
 * something else. Both app views count: the full-width viewer and the
 * chat-plus-app editing split (which on mobile is the minimized app strip
 * above the edit conversation).
 */
export function getVisibleAppIdForSend(): string | undefined {
  const { mainView, openedAppState } = useViewerStore.getState();
  if (mainView !== "app" && mainView !== "app-editing") {
    return undefined;
  }
  return openedAppState?.appId;
}
