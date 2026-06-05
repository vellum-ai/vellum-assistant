import { BrowserWindow, app, screen } from "electron";
import { z } from "zod";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { type VellumCommand } from "./commands";
import { handle } from "./ipc";
import { dispatchToMain, ensureVisible } from "./main-window";
import { createWindow } from "./windows";

/**
 * System-wide quick input window — a Spotlight-style floating panel the user
 * invokes via Cmd+Shift+/ to send a message without switching to the main
 * window. Matches the native Swift client's `QuickInputWindow` behavior:
 * frameless, always-on-top, auto-dismisses on blur, centered on the active
 * display slightly above center.
 *
 * `type: "panel"` maps to `NSWindowStyleMaskNonactivatingPanel` on macOS,
 * which receives keyboard input without stealing focus from the frontmost
 * app — the same underlying mechanism the Swift app's `NSPanel` uses.
 * Available since Electron 22; we require 42+.
 *
 * The UI is a React route in `apps/web/` — `/assistant/quick-input` —
 * following the same pattern as the About window. The route is standalone
 * (no auth middleware, no RootLayout) so it loads fast.
 */

const QUICK_INPUT_PATH = "/quick-input";

const PANEL_WIDTH = 720;
const PANEL_HEIGHT = 72;

const quickInputUrl = (): string => {
  const base = app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase();
  return `${base}${QUICK_INPUT_PATH}`;
};

let quickInputWindow: BrowserWindow | null = null;

const openQuickInput = (): void => {
  if (quickInputWindow && !quickInputWindow.isDestroyed()) {
    quickInputWindow.close();
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const activeDisplay = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = activeDisplay.workArea;

  quickInputWindow = createWindow({
    browserWindow: {
      type: "panel",
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      x: Math.round(x + (width - PANEL_WIDTH) / 2),
      // Slightly above center — matches Spotlight positioning.
      y: Math.round(y + (height - PANEL_HEIGHT) / 2 - height * 0.1),
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: true,
      vibrancy: "popover",
    },
    navigation: "deny-all",
  });

  quickInputWindow.once("ready-to-show", () => {
    quickInputWindow?.show();
  });

  quickInputWindow.on("blur", () => {
    if (quickInputWindow && !quickInputWindow.isDestroyed()) {
      quickInputWindow.close();
    }
  });

  quickInputWindow.on("closed", () => {
    quickInputWindow = null;
  });

  void quickInputWindow.loadURL(quickInputUrl());
};

/**
 * Toggle the quick input panel: if open, close it; if closed, open it.
 * Called from the global shortcut handler.
 */
export const toggleQuickInput = (): void => {
  openQuickInput();
};

let installed = false;

export const installQuickInput = (): void => {
  if (installed) return;
  installed = true;

  handle(
    "vellum:quickInput:submit",
    z.tuple([z.string()]),
    async ([message]) => {
      if (quickInputWindow && !quickInputWindow.isDestroyed()) {
        quickInputWindow.close();
      }

      await ensureVisible();

      const command: VellumCommand = { kind: "quickInputSubmit", message };
      dispatchToMain(command);
    },
  );

  handle("vellum:quickInput:dismiss", z.tuple([]), () => {
    if (quickInputWindow && !quickInputWindow.isDestroyed()) {
      quickInputWindow.close();
    }
  });
};
