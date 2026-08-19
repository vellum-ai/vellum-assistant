import { BrowserWindow, app, nativeTheme, shell } from "electron";
import {
  IDENTITY_NAME,
  MAIN_WINDOW_ENSURE_VISIBLE,
  MAIN_WINDOW_SET_ONBOARDING,
  MAIN_WINDOW_SET_TITLE_BAR_OVERLAY,
  titleBarOverlayThemeSchema,
  type ColorScheme,
  type TitleBarOverlayTheme,
  type VellumCommand,
} from "@vellumai/ipc-contract";
import {
  readTitleBarOverlayTheme,
  restoreBounds,
  track as trackWindowState,
  writeOnboardingActive,
  writeTitleBarOverlayTheme,
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
  const overlay = readTitleBarOverlayTheme();
  if (overlay) {
    syncNativeColorScheme(overlay.colorScheme);
  }
  const overlayColors = overlay
    ? { color: overlay.color, symbolColor: overlay.symbolColor }
    : {};
  const win = createWindow({
    browserWindow: {
      ...bounds,
      minWidth: MAIN_MIN_SIZE.width,
      minHeight: MAIN_MIN_SIZE.height,
      titleBarStyle: "hidden",
      titleBarOverlay: { ...overlayColors, height: TITLE_BAR_HEIGHT },
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

/**
 * Put the native color scheme on the scheme the app paints.
 *
 * Chromium washes a caption button on hover and press with a translucent layer
 * whose color comes from the native frame, not from the overlay's own color, so
 * a dark title bar under a light system scheme is washed in black on black and
 * the buttons stop responding to the pointer. Reporting the app's scheme puts
 * that wash on the right side of the surface underneath it.
 *
 * The scheme is left on `system` whenever the two already agree, so a theme
 * preference of "system" keeps following the OS.
 */
const syncNativeColorScheme = (colorScheme: ColorScheme): void => {
  // `shouldUseDarkColors` reflects the override once one is in force, so the
  // OS scheme is read from Windows' own setting whenever the app has overridden
  // it, and from the unoverridden theme otherwise.
  const systemPrefersDark =
    nativeTheme.themeSource === "system"
      ? nativeTheme.shouldUseDarkColors
      : nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  nativeTheme.themeSource =
    (colorScheme === "dark") === systemPrefersDark ? "system" : colorScheme;
};

/**
 * Paint the native caption buttons in the renderer's theme.
 *
 * The overlay is OS chrome drawn over the webview, so it can't inherit the
 * themed title bar it sits in: the colors have to be handed to it. They're
 * persisted as well as applied because they're `BrowserWindow` constructor
 * options, so the next launch builds its window themed instead of opening on
 * the system caption colors until the renderer reports its theme.
 */
const setTitleBarOverlay = (theme: TitleBarOverlayTheme): void => {
  writeTitleBarOverlayTheme(theme);
  syncNativeColorScheme(theme.colorScheme);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay({
      color: theme.color,
      symbolColor: theme.symbolColor,
      height: TITLE_BAR_HEIGHT,
    });
  }
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
  handle(
    MAIN_WINDOW_SET_TITLE_BAR_OVERLAY,
    z.tuple([titleBarOverlayThemeSchema]),
    ([theme], event) => {
      // Only the window wearing the overlay describes it. Every window runs the
      // same renderer bundle and reports whatever theme it applied: the
      // offscreen theme-stage window stages arbitrary workspace tokens for
      // screenshots, and auxiliary windows carry no workspace theme at all.
      if (event.sender !== mainWindow?.webContents) {
        return;
      }
      setTitleBarOverlay(theme);
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
