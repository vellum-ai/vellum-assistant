import { BrowserWindow, app, shell } from "electron";
import {
  IDENTITY_NAME,
  MAIN_WINDOW_ENSURE_VISIBLE,
  MAIN_WINDOW_SET_ONBOARDING,
  type VellumCommand,
} from "@vellumai/ipc-contract";
import {
  restoreBounds,
  track as trackWindowState,
  writeOnboardingActive,
} from "@vellumai/electron-desktop/window-state";
import { createWindowReadiness } from "@vellumai/electron-desktop/window-readiness";
import { z } from "zod";

import { getRendererRootUrl } from "./app-config";
import { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin.client";
import { handle, on } from "./ipc.client";
import log from "./logger";
import { createWindow } from "./windows.client";

const MAIN_DEFAULT_BOUNDS = { width: 1280, height: 800 } as const;
const MAIN_MIN_SIZE = { width: 800, height: 600 } as const;
const DEFAULT_WINDOW_TITLE = "Vellum";
const TITLE_BAR_HEIGHT = 44;

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let currentTitle = DEFAULT_WINDOW_TITLE;

const readiness = createWindowReadiness<BrowserWindow>();

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
  const { maximized, ...bounds } = restoreBounds(
    "main",
    MAIN_DEFAULT_BOUNDS,
  );
  const win = createWindow({
    browserWindow: {
      ...bounds,
      minWidth: MAIN_MIN_SIZE.width,
      minHeight: MAIN_MIN_SIZE.height,
      titleBarStyle: "hidden",
      titleBarOverlay: { height: TITLE_BAR_HEIGHT },
      show: false,
    },
    navigation: { installGuard: installSameOriginNavigationGuard },
    backgroundThrottling: false,
  });

  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  win.setTitle(currentTitle);
  trackWindowState("main", win);

  const ready = readiness.arm(win);
  win.webContents.once("did-finish-load", () => {
    ready.markLoaded();
  });
  win.once("ready-to-show", () => {
    if (maximized) {
      win.maximize();
    }
    win.show();
    win.focus();
    ready.markShown();
  });

  win.on("close", (event) => {
    if (isQuitting || win.isDestroyed()) {
      return;
    }
    event.preventDefault();
    win.hide();
  });

  win.on("closed", () => {
    ready.release();
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

/** Recreate if destroyed, restore from minimize, show, focus, and await load. */
export const ensureVisible = (): Promise<void> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    const win = createMainWindow();
    return readiness.wait(win);
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  return readiness.wait(mainWindow);
};

export const current = (): BrowserWindow | null => mainWindow;

export const dispatchToMain = (command: VellumCommand): void => {
  const win = current();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send("vellum:command", command);
  }
};

export const toggleVisibility = (): void => {
  const win = current();
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    win.hide();
    return;
  }
  ensureVisible();
};

export const setOnboarding = (active: boolean): void => {
  writeOnboardingActive(active);
};

const setAssistantName = (name: string): void => {
  const nextTitle = name.trim() || DEFAULT_WINDOW_TITLE;
  if (nextTitle === currentTitle) {
    return;
  }
  currentTitle = nextTitle;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(currentTitle);
  }
};

let installed = false;

/** Register main-window IPC and create the initial window. */
export const installMainWindow = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  app.once("before-quit", () => {
    isQuitting = true;
  });

  handle(MAIN_WINDOW_ENSURE_VISIBLE, z.tuple([]), async () => {
    await ensureVisible();
  });
  handle(
    MAIN_WINDOW_SET_ONBOARDING,
    z.tuple([z.boolean()]),
    ([active]) => {
      setOnboarding(active);
    },
  );
  on(IDENTITY_NAME, z.tuple([z.string()]), ([name]) => {
    setAssistantName(name);
  });

  void ensureVisible();
};

export const __resetForTesting = (): void => {
  installed = false;
  isQuitting = false;
  currentTitle = DEFAULT_WINDOW_TITLE;
};
