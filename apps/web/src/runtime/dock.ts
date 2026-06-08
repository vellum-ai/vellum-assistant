import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's Dock integration. Matches
 * the pattern in `native-biometric.ts`: the renderer never touches
 * `window.vellum.*` directly — feature code calls these named functions
 * and the cross-platform branch lives here.
 *
 * On non-Electron hosts (web, Capacitor iOS) both functions are no-ops,
 * so callers can fire them unconditionally on state change without an
 * `isElectron()` check at every call site.
 *
 * Both are fire-and-forget (`ipcRenderer.send` under the hood) — the main
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

/**
 * Publish the user's signed-in state. The main process uses this to
 * decide whether to keep the Dock icon visible after the last window
 * closes (so the user can re-open from the Dock vs. having to relaunch
 * from /Applications).
 *
 * Temporary — once main owns auth state directly, main becomes the
 * source of truth and this becomes a no-op the renderer drops. Safe to
 * call from any host — no-op off Electron.
 */
export function setDockSignedIn(signedIn: boolean): void {
  if (!isElectron()) return;
  window.vellum?.dock.setSignedIn(signedIn);
}
