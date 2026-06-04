import { isElectron } from "@/runtime/is-electron";

/**
 * Per-capability wrapper for the Electron host's Dock integration. Matches
 * the pattern in `native-biometric.ts`: the renderer never touches
 * `window.vellum.*` directly — feature code calls these named functions
 * and the cross-platform branch lives here.
 *
 * On non-Electron hosts (web, Capacitor iOS) both functions are no-ops
 * that resolve immediately, so callers can fire them unconditionally on
 * state change without an `isElectron()` check at every call site.
 */

/**
 * Publish the unread conversation count to the Electron Dock badge.
 * Main formats per Swift Vellum's convention (1–99 pass through, 99+
 * truncates). Pass `0` to clear.
 *
 * Safe to call from any host — no-op off Electron.
 */
export async function setDockBadge(count: number): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.dock.setBadge(count);
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
export async function setDockSignedIn(signedIn: boolean): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.dock.setSignedIn(signedIn);
}

/**
 * Set the macOS Dock icon to the active assistant's avatar, supplied as a
 * PNG data URL, or `null` to reset to the bundled branded (V) icon when the
 * assistant has no avatar. Keeps the Dock in lockstep with the in-app avatar
 * and the browser favicon (`use-dynamic-favicon`).
 *
 * `setIcon` is optional on the bridge — the web bundle and the macOS shell
 * don't release together, so an older shell may predate this channel and the
 * `?.` makes the call a no-op there. Safe to call from any host — no-op off
 * Electron.
 */
export async function setDockIcon(pngDataUrl: string | null): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.dock.setIcon?.(pngDataUrl);
}
