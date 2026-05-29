import { BrowserWindow, app, shell } from "electron";
import path from "node:path";

import {
  APP_HOST,
  APP_PROTOCOL,
  RENDERER_BASE_PROD,
  getDevRendererBase,
} from "./app-config";
import { type VellumCommand } from "./commands";
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

let mainWindow: BrowserWindow | null = null;

// Per-window readiness state. The tray's command menu items await
// `ensureVisible()` before dispatching IPC, so each freshly-created
// window needs its own promise — keyed by the `BrowserWindow`
// instance via a `WeakMap` so two near-simultaneous `createWindow`
// calls can't have the second's `armRenderReady` overwrite the
// first's resolver (or vice versa).
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
  const state: ReadyState = {
    promise,
    resolve,
    didFinishLoad: false,
    didShow: false,
  };
  readyStates.set(win, state);
  return state;
};

// Already-resolved sentinel for the "no window exists" path —
// `ensureVisible` returns a Promise even when there's nothing to
// wait for, so callers can compose `await` uniformly.
const ALREADY_READY: Promise<void> = Promise.resolve();

interface NavigationGuardConfig {
  isDev: boolean;
  devOrigin: string;
}

const installSameOriginNavigationGuard = (
  win: BrowserWindow,
  { isDev, devOrigin }: NavigationGuardConfig,
): void => {
  // Scoped to the main window — popups (OAuth flows etc.) need to
  // redirect between provider domains and our callback origin, so
  // they're left unrestricted.
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
  // Resolve the dev URL once per window construction so the loader
  // and the navigation guard see a consistent string even if
  // `VELLUM_DEV_URL` is mutated mid-process.
  //
  // The prod load target is the renderer base itself (no `/index.html`
  // suffix). The `app://` protocol handler in `index.ts` falls back
  // to `index.html` for paths without a file extension, so this
  // serves the SPA — but with the browser URL staying at `/assistant`,
  // which is where React Router's app-root route matches. Appending
  // `/index.html` would land us at the NotFound route under
  // `/assistant/*`.
  const isDev = !app.isPackaged;
  const devBase = isDev ? getDevRendererBase() : null;
  const loadTarget = devBase ?? RENDERER_BASE_PROD;
  const devOrigin = devBase ? new URL(devBase).origin : "";

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

  // Readiness resolves only after BOTH the renderer has loaded AND
  // the window has shown + focused. Per-window state keyed via
  // WeakMap so concurrent `createWindow` calls can't cross-resolve
  // each other's promise (the prior module-scope `resolveRenderReady`
  // had that race).
  const ready = armReadyState(win);
  const maybeResolveReady = (): void => {
    if (ready.didFinishLoad && ready.didShow) ready.resolve();
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

  win.on("closed", () => {
    // Unblock any pending `await ensureVisible()` so callers that hit
    // the destroyed-before-ready race (network failure during load,
    // user quit mid-load) don't hang forever. The caller's follow-up
    // dispatch then sees `current() === null` and no-ops; that's the
    // right semantics — the user closed the window, nothing should
    // happen.
    ready.resolve();
    if (mainWindow === win) mainWindow = null;
  });

  installSameOriginNavigationGuard(win, { isDev, devOrigin });

  win.loadURL(loadTarget).catch((err: unknown) => {
    console.error(`[main-window] loadURL failed for ${loadTarget}:`, err);
  });

  mainWindow = win;
  return win;
};

/**
 * Recreate if destroyed, restore from minimize, show, focus. Returns
 * a Promise that resolves once the new (or re-shown) main window is
 * visible AND focused AND its renderer has finished loading, so a
 * caller that immediately dispatches an IPC command via
 * `dispatchToFocused` (the tray) lands the command on the right
 * window. Callers that don't need the renderer (the `activate`
 * handler, `second-instance`) can `void` the return.
 *
 * Residual race: `did-finish-load` fires after the bundle parses but
 * before React's effect for `useVellumCommands` mounts. In practice
 * the gap is small (~ms) — a proper renderer→main "ready for
 * commands" IPC handshake is a separate ticket; for the tray's click
 * rate this is good enough.
 */
export const ensureVisible = (): Promise<void> => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    const win = createWindow();
    return readyStates.get(win)?.promise ?? ALREADY_READY;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // The existing window may still be mid-load (created very recently;
  // `did-finish-load` and/or `ready-to-show` haven't both fired yet),
  // so return its stored readiness instead of a fresh resolved
  // promise. If it's already loaded, the stored promise has already
  // resolved and the await is effectively free.
  return readyStates.get(mainWindow)?.promise ?? ALREADY_READY;
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
  void ensureVisible();
};

/**
 * Underlying `BrowserWindow | null`. Reserved for narrow callers that
 * need the actual reference (e.g. `dispatchToFocused`'s
 * `webContents.send`, `before-quit` cleanup inspecting the instance).
 * Most callers should compose from `ensureVisible` / `hide` instead.
 */
export const current = (): BrowserWindow | null => mainWindow;

/**
 * Send a `vellum:command` IPC message directly to the main window,
 * bypassing the application-menu `dispatchToFocused` "find focused
 * window" lookup. The tray click happens with the app potentially
 * backgrounded, so `getFocusedWindow()` can disagree with what the
 * user just clicked on — even after we call `win.focus()`, the OS
 * doesn't deliver the focus change synchronously. Targeting the
 * main window by reference sidesteps that entirely.
 *
 * No-op if the main window doesn't currently exist; the caller is
 * expected to have run `ensureVisible()` first.
 */
export const dispatchToMain = (command: VellumCommand): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("vellum:command", command);
};

/**
 * Create the initial main window. Call once from `whenReady`.
 * Idempotent: if a window is already alive, no-op.
 */
let installed = false;
export const installMainWindow = (): void => {
  if (installed) return;
  installed = true;
  void ensureVisible();
};
