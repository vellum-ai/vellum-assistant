import { BrowserWindow, app, shell } from "electron";
import { z } from "zod";

import type { VellumCommand } from "@vellumai/ipc-contract";

import { getRendererRootUrl } from "./app-config";
import { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin.client";
import { handle } from "./ipc.client";
import log from "./logger";
import { createWindow } from "./windows.client";

// Default and minimum bounds mirror the macOS Electron client
// (`clients/macos/src/main/main-window.ts`). Bounds persistence across
// launches (the macOS `window-state` module) is not ported yet.
const MAIN_DEFAULT_BOUNDS = { width: 1280, height: 800 } as const;
const MAIN_MIN_SIZE = { width: 800, height: 600 } as const;

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

interface ReadyState {
  promise: Promise<void>;
  resolve: () => void;
  didFinishLoad: boolean;
  didShow: boolean;
}

const readyStates = new WeakMap<BrowserWindow, ReadyState>();

const armReadyState = (win: BrowserWindow): ReadyState => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const state = { promise, resolve, didFinishLoad: false, didShow: false };
  readyStates.set(win, state);
  return state;
};

export const current = (): BrowserWindow | null => mainWindow;

export const dispatchToMain = (command: VellumCommand): void => {
  const win = current();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send("vellum:command", command);
  }
};

// Same-origin navigation guard: the window only ever navigates within the
// renderer origin; external http(s) links open in the default browser, and
// everything else is dropped. The macOS client additionally allows the OAuth
// sign-in chain (`clients/macos/src/main/auth-nav.ts`). Port that alongside
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
    if (isAllowedOrigin(parsed, allowedOrigin)) {
      return;
    }
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
    // renderer work in clients/web before it's worth enabling.
    browserWindow: {
      ...MAIN_DEFAULT_BOUNDS,
      minWidth: MAIN_MIN_SIZE.width,
      minHeight: MAIN_MIN_SIZE.height,
      show: false,
    },
    navigation: { installGuard: installSameOriginNavigationGuard },
  });

  const ready = armReadyState(win);
  const maybeResolveReady = (): void => {
    if (ready.didFinishLoad && ready.didShow) {
      ready.resolve();
    }
  };
  win.webContents.once("did-finish-load", () => {
    ready.didFinishLoad = true;
    maybeResolveReady();
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    ready.didShow = true;
    maybeResolveReady();
  });

  win.on("close", (event) => {
    if (isQuitting || win.isDestroyed()) {
      return;
    }
    event.preventDefault();
    win.hide();
  });

  win.on("closed", () => {
    ready.resolve();
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  const loadTarget = getRendererRootUrl(app.isPackaged);
  win.loadURL(loadTarget).catch((err: unknown) => {
    log.error(`[main-window] loadURL failed for ${loadTarget}:`, err);
  });

  mainWindow = win;
  return win;
};

/** Recreate if destroyed, restore from minimize, show, focus. */
export const ensureVisible = (): Promise<void> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    const win = createMainWindow();
    return readyStates.get(win)?.promise ?? Promise.resolve();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  return readyStates.get(mainWindow)?.promise ?? Promise.resolve();
};

export const toggleVisibility = (): void => {
  const win = current();
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    win.hide();
    return;
  }
  ensureVisible();
};

/** Create the initial main window. Call once from `whenReady`. */
export const installMainWindow = (): void => {
  app.once("before-quit", () => {
    isQuitting = true;
  });
  // Renderer-driven "bring the window forward" - used by feature consumers
  // reacting to inbound signals (deep links, notification clicks) once those
  // land here. Mirrors `clients/macos/src/main/main-window.ts`.
  handle("vellum:mainWindow:ensureVisible", z.tuple([]), () => {
    return ensureVisible();
  });

  void ensureVisible();
};
