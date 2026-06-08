import { isElectron } from "@/runtime/is-electron";

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
 */
export function WindowDragRegion() {
  if (!isElectron()) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-[100] h-7 [-webkit-app-region:drag]"
    />
  );
}
