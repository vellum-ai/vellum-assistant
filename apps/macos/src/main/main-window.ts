import { BrowserWindow, app, shell } from "electron";
import path from "node:path";

import { restoreBounds, track as trackWindowState } from "./window-state";

/**
 * Main BrowserWindow lifecycle owner.
 *
 * Other modules (tray, application menu, deep link handler, command
 * palette opener, etc.) used to reach into `index.ts`'s `mainWindow`
 * variable and reinvent "what does it mean to make the window
 * visible?" — recreate-if-destroyed checks, restore-from-minimize,
 * show, focus, the whole dance — at each call site. This module
 * collapses that into a single primitive every caller composes from.
 *
 * Public API:
 *
 *   - `ensureVisible()` — the primitive. Recreate if destroyed,
 *     restore if minimized, show, focus. Use this anywhere you'd
 *     previously have called `createWindow()` + extra checks. Safe
 *     to call repeatedly.
 *   - `hide()` — hide if visible; no-op if destroyed.
 *   - `toggleVisibility()` — hide if visible and focused; otherwise
 *     `ensureVisible()`. The tray's left-click and the
 *     "Show / Hide Main Window" menu item compose from this.
 *   - `isVisibleAndFocused()` — for callers that need to branch on
 *     "is the user looking at the main window right now?".
 *   - `current()` — the underlying `BrowserWindow | null`. Reserved
 *     for narrow cases (`webContents.send` from `dispatchToFocused`,
 *     `before-quit` cleanup that needs to inspect the instance).
 *     Most callers should use `ensureVisible` / `hide` instead.
 *
 * Follows the same `installX` + named-export pattern as `dock.ts` /
 * `about.ts` / `settings.ts` — module-scope state, public API, and
 * a single bootstrap hook (`installMainWindow`) called once from
 * `whenReady` to create the initial window.
 */

// Mirrors the protocol constants used by `registerAppProtocol` in
// `index.ts`. Inlined rather than imported across files because the
// surface is small and the protocol scheme is part of the app's
// stable identity — drift surfaces immediately as a broken renderer
// load. If a third caller needs these, lift to a shared module.
const APP_PROTOCOL = "app";
const APP_HOST = "vellum.ai";

const devServerUrl = (): string =>
  process.env.VELLUM_DEV_URL ?? "http://localhost:5173/assistant";

const loadUrl = (): string =>
  app.isPackaged
    ? `${APP_PROTOCOL}://${APP_HOST}/index.html`
    : devServerUrl();

let mainWindow: BrowserWindow | null = null;

const installSameOriginNavigationGuard = (win: BrowserWindow): void => {
  // Scoped to the main window — popups (OAuth flows etc.) need to
  // redirect between provider domains and our callback origin, so
  // they're left unrestricted.
  const isDev = !app.isPackaged;
  const devOrigin = new URL(devServerUrl()).origin;
  win.webContents.on("will-navigate", (event, url) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    const allowed =
      (isDev && target.origin === devOrigin) ||
      (!isDev &&
        target.protocol === `${APP_PROTOCOL}:` &&
        target.host === APP_HOST);
    if (allowed) return;
    event.preventDefault();
    // External http(s) top-level navigations (e.g.
    // `window.location.href = "https://billing.stripe.com/..."`) route
    // to the system browser instead of silently failing. Other schemes
    // stay blocked.
    if (target.protocol === "https:" || target.protocol === "http:") {
      void shell.openExternal(url);
    }
  });
};

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    ...restoreBounds("main", { width: 1280, height: 800 }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: !app.isPackaged,
    },
  });

  trackWindowState("main", win);

  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  installSameOriginNavigationGuard(win);

  const target = loadUrl();
  win.loadURL(target).catch((err: unknown) => {
    console.error(`[main-window] loadURL failed for ${target}:`, err);
  });

  mainWindow = win;
  return win;
};

export const ensureVisible = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

export const hide = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
};

export const isVisibleAndFocused = (): boolean =>
  !!mainWindow &&
  !mainWindow.isDestroyed() &&
  mainWindow.isVisible() &&
  mainWindow.isFocused();

export const toggleVisibility = (): void => {
  if (isVisibleAndFocused()) {
    hide();
    return;
  }
  ensureVisible();
};

/**
 * Underlying `BrowserWindow | null`. Reserved for narrow callers that
 * need the actual reference (e.g. `dispatchToFocused`'s
 * `webContents.send`, `before-quit` cleanup inspecting the instance).
 * Most callers should compose from `ensureVisible` / `hide` instead.
 */
export const current = (): BrowserWindow | null => mainWindow;

/**
 * Create the initial main window. Call once from `whenReady`.
 * Idempotent: if a window is already alive, no-op.
 */
let installed = false;
export const installMainWindow = (): void => {
  if (installed) return;
  installed = true;
  ensureVisible();
};
