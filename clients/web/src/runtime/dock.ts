import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's Dock integration. Matches
 * the pattern in `native-biometric.ts`: the renderer never touches
 * `window.vellum.*` directly — feature code calls these named functions
 * and the cross-platform branch lives here.
 *
 * On non-Electron hosts (web, Capacitor iOS) the function is a no-op,
 * so callers can fire it unconditionally on state change without an
 * `isElectron()` check at every call site.
 *
 * Fire-and-forget (`ipcRenderer.send` under the hood) — the main
 * process applies the change and there is nothing to await, matching the
 * one-way publish style of `status.ts` / `icon.ts`.
 */

/**
 * Publish the unread conversation count to the Electron Dock badge.
 * Main formats per Swift Vellum's convention (1–99 pass through, 99+
 * truncates). Pass `0` to clear.
 *
 * Safe to call from any host — no-op off Electron.
 */
export function setDockBadge(count: number): void {
  if (!isElectron()) return;
  window.vellum?.dock.setBadge(count);
}
