import { Capacitor } from "@capacitor/core";

import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import { isElectron } from "@/runtime/is-electron";

/**
 * Opens a URL in the most appropriate context:
 * - Electron: system browser via the main-process `setWindowOpenHandler`
 *   (which routes `target=_blank` opens to `shell.openExternal`).
 * - Native (Capacitor): `SFSafariViewController` via `@capacitor/browser`,
 *   which keeps the user inside the app and properly handles OAuth / Stripe
 *   redirect flows that would otherwise break out to Safari.
 * - Web: falls back to `window.location.href` (same-tab navigation), matching
 *   the previous behaviour.
 *
 * The plugin is lazy-imported so it is never loaded in SSR or plain-browser
 * contexts where the Capacitor runtime is absent.
 */
export const openUrl = async (url: string): Promise<void> => {
  if (isElectron()) {
    window.open(url, "_blank");
    return;
  }
  if (Capacitor.isNativePlatform()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url, presentationStyle: "popover" });
    } catch {
      // Plugin not available (e.g. older app binary without @capacitor/browser
      // registered). Fall back to same-tab navigation so checkout still works.
      window.location.href = url;
    }
  } else {
    window.location.href = url;
  }
};

/**
 * Subscribe to the Capacitor Browser `browserFinished` event, which fires
 * when the user dismisses the `SFSafariViewController`. Returns an
 * unsubscribe function. No-ops in non-native contexts.
 *
 * Usage:
 *   useEffect(() => openUrlFinishedListener(() => { refetch(); onClose(); }), []);
 */
export const openUrlFinishedListener = (callback: () => void): (() => void) =>
  subscribeCapacitorListener("capacitor_browser_finished", async () => {
    const { Browser } = await import("@capacitor/browser");
    return Browser.addListener("browserFinished", callback);
  });
