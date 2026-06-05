import { Menu, Tray, app, nativeTheme } from "electron";

import { onAvatarChange } from "./avatar";
import { resolveAccelerator } from "./commands";
import { dispatchToMain } from "./main-window";
import {
  getStatus,
  onStatusChange,
  PULSE_FRAME_INTERVAL_MS,
  shouldPulse,
  statusMenuTitle,
  type AssistantStatus,
} from "./status";
import { invalidateIconCache, statusFrames } from "./status-icon";
import { readOnboardingActive } from "./window-state";

/**
 * macOS menu-bar (Tray) status item.
 *
 * Mirrors what the Swift app's `NSStatusItem` does in
 * `AppDelegate+MenuBar.swift`: a persistent menu-bar icon showing the
 * assistant avatar (brand glyph when no avatar is set) with a live status
 * dot, single-click toggles the main window, right-click pops a
 * quick-actions menu led by a status line.
 *
 * Electron tray gotchas:
 *
 *   - Don't call `tray.setContextMenu()`. With it, left and right click
 *     both open the same menu — overriding the documented Linear /
 *     menu-bar-app pattern of "click toggles, right-click opens menu."
 *     Instead, register `click` + `right-click` listeners and call
 *     `tray.popUpContextMenu(menu)` manually from the right-click path.
 *   - `tray.setIgnoreDoubleClickEvents(true)` so two fast single clicks
 *     are treated as two `click` events instead of being coalesced into
 *     a swallowed double-click on macOS.
 *   - The icon is a colored, non-template image (avatar or brand mark +
 *     status dot), matching the Swift app. Template images auto-invert
 *     for dark mode but are masked to one color and can't carry the dot;
 *     see `status-icon.ts` for the full rationale.
 *   - Hold a module-scope `Tray` reference. Without it Node's GC can
 *     collect the JS handle and the icon disappears from the menu bar
 *     even though the underlying NSStatusItem is still alive.
 *   - Electron's `Tray` has no animation API, so the `thinking` pulse
 *     is driven by swapping pre-rendered frames on a `setInterval`; the
 *     timer is cleared on every state change and on quit so it never
 *     outlives the pulsing state or leaks across reloads.
 */

export interface TrayHandlers {
  /**
   * Bound to the tray's left click and the "Show / Hide Main Window"
   * menu item: if the main window is visible and focused, hide it;
   * otherwise show + focus + (recreate if previously destroyed).
   */
  toggleMainWindow(): void;
  /**
   * Bound to the conversation menu items below. Renderer-bound
   * commands (`newConversation`, `currentConversation`) only update
   * state — without surfacing the window first, nothing visible
   * happens when the user picks them from the tray. Returns a Promise
   * that resolves once the renderer has finished loading, so the
   * dispatched command isn't dropped on the floor if the BrowserWindow
   * was just recreated.
   */
  ensureMainWindow(): Promise<void>;
  /**
   * Open (or focus the existing) About window.
   */
  openAbout(): void;
}

const buildTrayMenu = (handlers: TrayHandlers, status: AssistantStatus): Menu =>
  Menu.buildFromTemplate([
    {
      // Status line, matching the Swift status menu's header. Disabled so
      // it reads as a label, not an action.
      label: statusMenuTitle(status),
      enabled: false,
    },
    { type: "separator" },
    {
      label: "New Conversation",
      accelerator: resolveAccelerator("newConversation"),
      click: async () => {
        await handlers.ensureMainWindow();
        // Dispatch by reference (not `dispatchToFocused`'s
        // `getFocusedWindow` lookup) — the tray click happens with
        // the app potentially backgrounded, so even after our
        // `win.focus()` the OS may not have delivered focus by the
        // time this runs. Targeting main directly is unambiguous.
        dispatchToMain({ kind: "newConversation" });
      },
    },
    {
      label: "Current Conversation",
      accelerator: resolveAccelerator("currentConversation"),
      click: async () => {
        await handlers.ensureMainWindow();
        dispatchToMain({ kind: "currentConversation" });
      },
    },
    { type: "separator" },
    {
      label: "Show / Hide Main Window",
      click: handlers.toggleMainWindow,
    },
    { type: "separator" },
    {
      label: "Settings\u2026",
      enabled: !readOnboardingActive(),
      click: async () => {
        await handlers.ensureMainWindow();
        dispatchToMain({ kind: "openSettings" });
      },
    },
    {
      label: `About ${app.name}`,
      click: handlers.openAbout,
    },
    { type: "separator" },
    {
      label: `Quit ${app.name}`,
      // `role: "quit"` carries its own accelerator on macOS; we still
      // declare it explicitly so the menu reads consistently across
      // locales and Electron version bumps.
      accelerator: "CmdOrCtrl+Q",
      role: "quit",
    },
  ]);

let installed = false;
let trayInstance: Tray | null = null;
let pulseTimer: ReturnType<typeof setInterval> | null = null;

const stopPulse = (): void => {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
};

/**
 * Reflect `status` on the tray: swap the icon, refresh the tooltip, and start
 * or stop the pulse. Static states show their single frame; `thinking` cycles
 * its pre-rendered opacity frames on a timer. The timer is always cleared
 * first so a state change can't leave two pulses running or a stale timer
 * driving the wrong icon. The right-click menu is built lazily at pop time
 * (see `installTray`), so it reflects the current status without rebuilding
 * here on every tick.
 */
const applyStatus = (status: AssistantStatus): void => {
  const tray = trayInstance;
  if (!tray) return;

  stopPulse();
  tray.setToolTip(statusMenuTitle(status));

  const frames = statusFrames(status);
  tray.setImage(frames[0]!);

  if (shouldPulse(status) && frames.length > 1) {
    let index = 0;
    pulseTimer = setInterval(() => {
      index = (index + 1) % frames.length;
      trayInstance?.setImage(frames[index]!);
    }, PULSE_FRAME_INTERVAL_MS);
  }
};

/**
 * Wire the menu-bar status item. Call once from `whenReady`. Idempotent
 * — repeated calls are no-ops, so it's safe under hot-reload of the
 * main bundle in dev.
 *
 * The handlers are passed in (rather than imported) so the tray module
 * stays decoupled from `index.ts`'s lifecycle state. The main process
 * is the only place that knows what "toggle the main window" means
 * today, and that knowledge stays there.
 *
 * The tray subscribes to `onStatusChange` so the renderer-published
 * connection status drives the icon, tooltip, and pulse; to `onAvatarChange`
 * so a new (or cleared) avatar re-renders the icon base; and to
 * `nativeTheme` updates so the live status-dot color tracks Dark Mode and
 * accessibility changes — all without `index.ts` having to relay transitions.
 */
export const installTray = (handlers: TrayHandlers): void => {
  if (installed) return;
  installed = true;

  const initialStatus = getStatus();
  trayInstance = new Tray(statusFrames(initialStatus)[0]!);
  trayInstance.setIgnoreDoubleClickEvents(true);

  trayInstance.on("click", () => {
    handlers.toggleMainWindow();
  });

  // Build the right-click menu lazily, once, at pop time. `popUpContextMenu`
  // takes the menu by value when called, so building it here — reading the
  // current `getStatus()` for the header line — keeps the status line fresh
  // without rebuilding the menu and rebinding this listener on every status
  // tick (idle↔thinking fires on every turn).
  trayInstance.on("right-click", () => {
    trayInstance?.popUpContextMenu(buildTrayMenu(handlers, getStatus()));
  });

  // Re-render the icon when the avatar or the system appearance changes: both
  // invalidate the cached base/frames, then re-apply the current status so the
  // new base image or dot color shows immediately.
  const refreshIcon = (): void => {
    invalidateIconCache();
    applyStatus(getStatus());
  };

  applyStatus(initialStatus);
  const unsubscribeStatus = onStatusChange(applyStatus);
  const unsubscribeAvatar = onAvatarChange(refreshIcon);
  nativeTheme.on("updated", refreshIcon);

  // Explicit destroy on quit. In production the OS releases the
  // NSStatusItem when the process exits anyway; in dev with main-process
  // hot reload, freeing the JS handle ourselves avoids a ghost menu-bar
  // icon for a beat between reloads. Stopping the pulse + unsubscribing
  // keeps the timers and listeners from outliving the tray.
  app.on("before-quit", () => {
    stopPulse();
    unsubscribeStatus();
    unsubscribeAvatar();
    nativeTheme.removeListener("updated", refreshIcon);
    trayInstance?.destroy();
    trayInstance = null;
  });
};

// Test seam — exported only for unit-test setup. Production code uses
// `installTray` instead.
export const __resetForTesting = (): void => {
  stopPulse();
  installed = false;
  trayInstance = null;
};
