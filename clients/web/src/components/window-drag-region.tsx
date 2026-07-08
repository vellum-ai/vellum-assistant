import { useState } from "react";

import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindow } from "@/runtime/popout-window";
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
 * - Yields entirely in Electron pop-out thread windows (`?popout=1`): those
 *   windows keep their NATIVE title bar (the desktop shell's
 *   `popout-window.ts` passes no `titleBarStyle`), so the OS already provides
 *   dragging — and since pop-outs never mount `ChatLayoutHeader` (the only
 *   `inlineTitleBarActive` setter), leaving the strip up would permanently
 *   swallow clicks on the standalone voice-session pill floated at the
 *   window's top-right (see `VoiceSessionPillHost`).
 */
export function WindowDragRegion() {
  const inlineTitleBarActive = useTitleBarStore.use.inlineTitleBarActive();
  // Captured once at mount, mirroring `ChatLayout`: pop-out URLs carry the
  // flag only on initial load. This component mounts outside the router, so
  // it reads `window.location` directly rather than `useLocation`.
  const [isPopout] = useState(() => isPopoutWindow(window.location.search));
  if (!isElectron()) return null;
  if (isPopout) return null;
  if (inlineTitleBarActive) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-[100] h-7 [-webkit-app-region:drag]"
    />
  );
}
