import { Menu, Tray, app, nativeImage, type NativeImage } from "electron";

import { dispatchToFocused, resolveAccelerator } from "./commands";

/**
 * macOS menu-bar (Tray) status item.
 *
 * Mirrors what the Swift app's `NSStatusItem` does in
 * `AppDelegate+MenuBar.swift`: persistent menu-bar icon, single-click
 * toggles the main window, right-click pops a quick-actions menu. The
 * 5-state pulse status indicator that Swift renders on top of the icon
 * lands in a follow-up — this PR puts the icon + click wiring in place
 * so the rest of the app feels like Swift Vellum.
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
 *   - Template images only (PNG with alpha; black-on-transparent).
 *     macOS auto-inverts for dark mode and pressed state; colored icons
 *     look wrong against accent tints
 *     (https://github.com/electron/electron/issues/19006).
 *   - Hold a module-scope `Tray` reference. Without it Node's GC can
 *     collect the JS handle and the icon disappears from the menu bar
 *     even though the underlying NSStatusItem is still alive.
 */

export interface TrayHandlers {
  /**
   * Show + focus the main window if it's hidden, hide it if it's
   * already focused. Caller decides what "hidden" means today — see
   * `installTray` invocation in `index.ts`.
   */
  toggleMainWindow(): void;
  /**
   * Open (or focus the existing) About window.
   */
  openAbout(): void;
}

const ICON_SIZE = 16;

/**
 * Placeholder template icon — a thin outlined circle. The assistant
 * avatar + status-dot rendering lands with the pulse-animation ticket
 * and the assistant-identity bridge; until then, an outlined circle is
 * enough that the menu bar shows *something* and the user can find the
 * app.
 *
 * Generated programmatically so this PR ships no binary assets. The
 * follow-up that introduces real avatar/state-dot artwork will switch
 * to `nativeImage.createFromPath(...)` against shipped PNG resources.
 */
const buildPlaceholderIcon = (): NativeImage => {
  const buf = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const center = ICON_SIZE / 2 - 0.5;
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Anti-aliased ring at radius ~6 with width ~1.5px. Alpha drops
      // off at the inner + outer edges so the icon doesn't look pixelated
      // at standard density.
      const inner = Math.max(0, Math.min(1, dist - 4.5));
      const outer = Math.max(0, Math.min(1, 6 - dist));
      const alpha = Math.round(255 * Math.min(inner, outer));
      const offset = (y * ICON_SIZE + x) * 4;
      buf[offset + 0] = 0;
      buf[offset + 1] = 0;
      buf[offset + 2] = 0;
      buf[offset + 3] = alpha;
    }
  }
  const img = nativeImage.createFromBitmap(buf, {
    width: ICON_SIZE,
    height: ICON_SIZE,
  });
  img.setTemplateImage(true);
  return img;
};

const buildTrayMenu = (handlers: TrayHandlers): Menu =>
  Menu.buildFromTemplate([
    {
      label: "New Conversation",
      accelerator: resolveAccelerator("newConversation"),
      click: () => dispatchToFocused({ kind: "newConversation" }),
    },
    {
      label: "Current Conversation",
      accelerator: resolveAccelerator("currentConversation"),
      click: () => dispatchToFocused({ kind: "currentConversation" }),
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

/**
 * Wire the menu-bar status item. Call once from `whenReady`. Idempotent
 * — repeated calls are no-ops, so it's safe under hot-reload of the
 * main bundle in dev.
 *
 * The handlers are passed in (rather than imported) so the tray module
 * stays decoupled from `index.ts`'s lifecycle state. The main process
 * is the only place that knows what "toggle the main window" means
 * today, and that knowledge stays there.
 */
export const installTray = (handlers: TrayHandlers): void => {
  if (installed) return;
  installed = true;

  trayInstance = new Tray(buildPlaceholderIcon());
  trayInstance.setIgnoreDoubleClickEvents(true);
  trayInstance.setToolTip(app.name);

  trayInstance.on("click", () => {
    handlers.toggleMainWindow();
  });

  const menu = buildTrayMenu(handlers);
  trayInstance.on("right-click", () => {
    trayInstance?.popUpContextMenu(menu);
  });
};
