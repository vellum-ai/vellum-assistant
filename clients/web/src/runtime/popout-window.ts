import { isElectron } from "@/runtime/is-electron";

/**
 * Whether a location search string marks the window as an Electron pop-out
 * thread window (`?popout=1`, appended by the desktop shell's popout-window
 * loader). Pop-out URLs carry the flag only on the window's initial load —
 * in-window navigations (e.g. conversation switching via Cmd+Up/Down) drop
 * the query — so callers that need the answer for the window's lifetime must
 * capture it once at mount (see `ChatLayout` / `WindowDragRegion`).
 */
export function isPopoutWindow(search: string): boolean {
  return search.includes("popout=1");
}

// Captured at module load, while the initial URL still carries `?popout=1`
// (in-window navigations drop the query). `typeof window` guard keeps the
// module importable under SSR/tooling contexts with no window.
const INITIAL_LOAD_IS_POPOUT =
  typeof window !== "undefined" && isPopoutWindow(window.location.search);

/**
 * Whether THIS window is an Electron pop-out thread window, valid for the
 * window's whole lifetime. Unlike `isPopoutWindow(location.search)` — which
 * per-route components can only trust at their own mount time, and which
 * reads false after an in-window navigation drops the query — this is the
 * initial-load answer, so components that remount mid-lifetime (e.g. the
 * composer) get the correct window-lifetime value.
 */
export function isPopoutWindowLifetime(): boolean {
  return INITIAL_LOAD_IS_POPOUT;
}

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
