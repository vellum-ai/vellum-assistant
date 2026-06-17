import { isElectron } from "@/runtime/is-electron";
import { useTitleBarStore } from "@/stores/title-bar-store";

/**
 * Electron-only window drag strip.
 *
 * The macOS main window runs with `titleBarStyle: "hidden"` (see the desktop
 * app's `main-window.ts`), which removes the native title bar — and with it
 * the OS-provided drag handle. This restores window dragging by declaring a
 * draggable region (`-webkit-app-region: drag`) pinned across the top of the
 * window, where the title bar used to sit.
 *
 * Notes:
 * - The macOS traffic lights render above the webview, so they stay clickable
 *   even though this strip overlaps them.
 * - Any interactive element intentionally placed inside this top band must
 *   opt back out with `-webkit-app-region: no-drag` (Tailwind:
 *   `[-webkit-app-region:no-drag]`) or it will be unclickable — a drag region
 *   swallows pointer events.
 * - No-ops off Electron (web / Capacitor iOS), so those layouts are untouched.
 * - Yields on the main-app chat routes, where `ChatLayoutHeader` is the inline
 *   title bar and owns dragging itself. This strip renders *outside*
 *   `.app-shell` (an `isolation: isolate` stacking context), so leaving it up
 *   would out-stack the header's buttons and swallow their clicks. See
 *   {@link useTitleBarStore}.
 */
export function WindowDragRegion() {
  const inlineTitleBarActive = useTitleBarStore.use.inlineTitleBarActive();
  if (!isElectron()) return null;
  if (inlineTitleBarActive) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-[100] h-7 [-webkit-app-region:drag]"
    />
  );
}
