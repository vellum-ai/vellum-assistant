import { useState } from "react";

import { WindowsMenuBar } from "@/components/windows-menu-bar";
import { WINDOWS_TITLE_BAR_CONTROL_CLEARANCE_PX } from "@/runtime/electron-window-chrome";
import { isPopoutWindow } from "@/runtime/popout-window";
import { detectElectronHostOS } from "@/runtime/platform-detection";
import { useTitleBarStore } from "@/stores/title-bar-store";

/**
 * Electron-only window drag strip.
 *
 * Desktop main windows hide the native title bar. This restores window
 * dragging with a draggable region pinned across the top of the window.
 *
 * Notes:
 * - Native window controls render above the webview. On Windows the strip
 *   stops before the title-bar overlay controls.
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
  const hostOS = detectElectronHostOS();
  if (hostOS === null) {
    return null;
  }
  if (isPopout) {
    return null;
  }
  if (inlineTitleBarActive) {
    return null;
  }

  // On Windows the strip doubles as the menu-bar host: routes without the
  // inline chat title bar (settings, logs, onboarding) would otherwise have
  // no File/Edit/View menus at all, since the hidden native frame hides the
  // OS menu bar too. The strip already swallows pointer events in this band,
  // so the buttons claim no space that was interactive before.
  return (
    <div
      aria-hidden={hostOS === "windows" ? undefined : "true"}
      className={`fixed left-0 top-0 z-[100] h-7 [-webkit-app-region:drag] ${
        hostOS === "windows" ? "flex items-center pl-1" : "right-0"
      }`}
      style={
        hostOS === "windows"
          ? { right: WINDOWS_TITLE_BAR_CONTROL_CLEARANCE_PX }
          : undefined
      }
    >
      {hostOS === "windows" ? <WindowsMenuBar /> : null}
    </div>
  );
}
