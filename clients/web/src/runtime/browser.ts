import { Capacitor } from "@capacitor/core";

import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import { isElectron } from "@/runtime/is-electron";

/**
 * Shared cross-shell open routing. Electron (external system browser) and
 * native Capacitor (`SFSafariViewController`) never unload the current page;
 * only the plain-web path varies, so callers supply the web fallback.
 *
 * The plugin is lazy-imported so it is never loaded in SSR or plain-browser
 * contexts where the Capacitor runtime is absent.
 */
const openUrlAcrossShells = async (
  url: string,
  webFallback: (url: string) => void,
): Promise<void> => {
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
      // registered). Fall back to the web behaviour so checkout still works.
      webFallback(url);
    }
  } else {
    webFallback(url);
  }
};

/**
 * Opens a URL in the most appropriate context:
 * - Electron: system browser via the main-process `setWindowOpenHandler`
 *   (which routes `target=_blank` opens to `shell.openExternal`).
 * - Native (Capacitor): `SFSafariViewController` via `@capacitor/browser`,
 *   which keeps the user inside the app and properly handles OAuth / Stripe
 *   redirect flows that would otherwise break out to Safari.
 * - Web: falls back to `window.location.href` (same-tab navigation), matching
 *   the previous behaviour.
 */
export const openUrl = (url: string): Promise<void> =>
  openUrlAcrossShells(url, (u) => {
    window.location.href = u;
  });

/**
 * Like {@link openUrl}, but the plain-web fallback opens a new tab
 * (`window.open`) instead of same-tab navigation, so the current page — and any
 * pending state on it — survives. Use for flows that must not unload the page,
 * e.g. the Connect Claude paths where the tab keeps polling / awaiting a pasted
 * code. Electron and native open externally and never unload the page.
 *
 * Resolves `false` only when the plain-web pop-up was blocked, so callers can
 * prompt a retry instead of silently waiting on a tab that never opened; always
 * `true` on Electron/native (which are never pop-up-blocked).
 */
export const openUrlInNewTab = async (url: string): Promise<boolean> => {
  if (isElectron()) {
    window.open(url, "_blank");
    return true;
  }
  if (Capacitor.isNativePlatform()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url, presentationStyle: "popover" });
      return true;
    } catch {
      // Plugin unavailable (older app binary) — fall through to the web path.
    }
  }
  // Plain web: a `window.open` issued after an `await` can outlast the click's
  // transient activation on a slow response and be pop-up-blocked, returning
  // null. `noopener` is intentionally dropped here — it forces `window.open` to
  // return null unconditionally, which would hide the block. The destination is
  // the trusted Claude OAuth page, so the reverse-tabnabbing exposure is
  // immaterial.
  const opened = window.open(url, "_blank");
  return opened !== null;
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
