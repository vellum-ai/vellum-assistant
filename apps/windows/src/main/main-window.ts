import { BrowserWindow, app, shell } from "electron";
import { z } from "zod";

import { getRendererRootUrl } from "./app-config";
import { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin";
import { handle } from "./ipc";
import log from "./logger";
import { createWindow } from "./windows";

// Default and minimum bounds mirror the macOS Electron client
// (`apps/macos/src/main/main-window.ts`). Bounds persistence across
// launches (the macOS `window-state` module) is not ported yet.
const MAIN_DEFAULT_BOUNDS = { width: 1280, height: 800 } as const;
const MAIN_MIN_SIZE = { width: 800, height: 600 } as const;

let mainWindow: BrowserWindow | null = null;

// Same-origin navigation guard: the window only ever navigates within the
// renderer origin; external http(s) links open in the default browser, and
// everything else is dropped. The macOS client additionally allows the OAuth
// sign-in chain (`apps/macos/src/main/auth-nav.ts`) — port that alongside
// native auth.
const installSameOriginNavigationGuard = (win: BrowserWindow): void => {
  const allowedOrigin = resolveAllowedOrigin();

  win.webContents.on("will-navigate", (event, url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (isAllowedOrigin(parsed, allowedOrigin)) return;
    event.preventDefault();
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      void shell.openExternal(url);
    }
  });
};

const createMainWindow = (): BrowserWindow => {
  const win = createWindow({
    // Standard native frame for now. The macOS client hides the title bar and
    // aligns the renderer's inline header with the traffic lights; the Windows
    // equivalent (`titleBarStyle: "hidden"` + `titleBarOverlay`) needs matching
    // renderer work in apps/web before it's worth enabling.
    browserWindow: {
      ...MAIN_DEFAULT_BOUNDS,
      minWidth: MAIN_MIN_SIZE.width,
      minHeight: MAIN_MIN_SIZE.height,
      show: false,
    },
    navigation: { installGuard: installSameOriginNavigationGuard },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  const loadTarget = getRendererRootUrl(app.isPackaged);
  win.loadURL(loadTarget).catch((err: unknown) => {
    log.error(`[main-window] loadURL failed for ${loadTarget}:`, err);
  });

  mainWindow = win;
  return win;
};

/** Recreate if destroyed, restore from minimize, show, focus. */
export const ensureVisible = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

/** Create the initial main window. Call once from `whenReady`. */
export const installMainWindow = (): void => {
  // Renderer-driven "bring the window forward" — used by feature consumers
  // reacting to inbound signals (deep links, notification clicks) once those
  // land here. Mirrors `apps/macos/src/main/main-window.ts`.
  handle("vellum:mainWindow:ensureVisible", z.tuple([]), () => {
    ensureVisible();
  });

  ensureVisible();
};
