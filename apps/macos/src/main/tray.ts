import { Menu, Tray, app } from "electron";

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
import { statusFrames } from "./status-icon";

/**
 * macOS menu-bar (Tray) status item.
 *
 * Mirrors what the Swift app's `NSStatusItem` does in
 * `AppDelegate+MenuBar.swift`: a persistent menu-bar icon showing the
 * brand glyph with a live status dot, single-click toggles the main
 * window, right-click pops a quick-actions menu led by a status line.
 *
 * Implementation notes carried over from `apps/macos/docs/PATTERNS.md`
 * (state ownership) and the Electron tray gotchas:
 *
 *   - Don't call `tray.setContextMenu()`. With it, left and right click
 *     both open the same menu — overriding the documented Linear /
 *     menu-bar-app pattern of "click toggles, right-click opens menu."
 *     Instead, register `click` + `right-click` listeners and call
 *     `tray.popUpContextMenu(menu)` manually from the right-click path.
 *   - `tray.setIgnoreDoubleClickEvents(true)` so two fast single clicks
 *     are treated as two `click` events instead of being coalesced into
 *     a swallowed double-click on macOS.
 *   - The icon is a colored, non-template image (brand mark + status
 *     dot), matching the Swift app. Template images auto-invert for
 *     dark mode but are masked to one color and can't carry the dot;
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
 * Reflect `status` on the tray: swap the icon, refresh the tooltip and the
 * status-line menu header, and start or stop the pulse. Static states show
 * their single frame; `thinking` cycles its pre-rendered opacity frames on a
 * timer. The timer is always cleared first so a state change can't leave two
 * pulses running or a stale timer driving the wrong icon.
 */
const applyStatus = (handlers: TrayHandlers, status: AssistantStatus): void => {
  const tray = trayInstance;
  if (!tray) return;

  stopPulse();
  tray.setToolTip(statusMenuTitle(status));
  // Rebuild the menu so the status-line header tracks the current state, and
  // re-bind it to the right-click handler (popUpContextMenu takes the menu by
  // value at pop time, so the latest reference must be the one captured).
  const menu = buildTrayMenu(handlers, status);
  tray.removeAllListeners("right-click");
  tray.on("right-click", () => {
    trayInstance?.popUpContextMenu(menu);
  });

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
 * connection status drives the icon, tooltip, pulse, and status header
 * without `index.ts` having to relay each transition.
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

  applyStatus(handlers, initialStatus);
  const unsubscribe = onStatusChange((status) => {
    applyStatus(handlers, status);
  });

  // Explicit destroy on quit. In production the OS releases the
  // NSStatusItem when the process exits anyway; in dev with main-process
  // hot reload, freeing the JS handle ourselves avoids a ghost menu-bar
  // icon for a beat between reloads. Stopping the pulse + unsubscribing
  // keeps the timer and listener from outliving the tray.
  app.on("before-quit", () => {
    stopPulse();
    unsubscribe();
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
