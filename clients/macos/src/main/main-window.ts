import { BrowserWindow, app, shell } from "electron";
import { z } from "zod";

import { getRendererRootUrl } from "./app-config";
import { resolveAllowedOrigin } from "./app-origin";
import { decideNavigation } from "./auth-nav";
import { type VellumCommand } from "./commands";
import { getName, onNameChange } from "./identity";
import { handle } from "./ipc";
import { createWindow } from "./windows";
import {
  readOnboardingActive,
  restoreBounds,
  track as trackWindowState,
  writeOnboardingActive,
} from "./window-state";

// Default state for the main window once onboarding is done: maximized — a
// normal window filling the display's work area, deliberately NOT native
// macOS fullscreen. Applies only until a real session is persisted; after
// that, `window-state` restores whatever bounds/mode the user left.
const MAIN_DEFAULT_STATE = "maximized";

// Minimum size for the window in every mode (onboarding included), mirroring
// the macOS Swift client's main window (`MainWindow.swift`: `contentMinSize`
// 800×600). The window can't be dragged below this — the roomy desktop floor
// the chat layout (sidebar rail + content) needs.
const MAIN_MIN_SIZE = { width: 800, height: 600 } as const;

// Fallback main-window title before the renderer publishes the assistant's
// name (and after it clears on sign-out / assistant switch). The live name —
// e.g. "Aria" — replaces this and drives the Window menu, the Cmd-`
// switcher, and Mission Control. `titleBarStyle: "hidden"` means it isn't
// painted in a title bar, but the OS-level NSWindow title still feeds those
// surfaces.
const DEFAULT_WINDOW_TITLE = "Vellum";

// macOS traffic-light (window controls) position for the main-app layout.
//
// The renderer's chat header (`clients/web` `ChatLayoutHeader`) renders as a
// unified ~44px title bar whose icon row sits *inline* with the window
// controls. To line them up we vertically centre the ~14px-tall traffic
// light cluster in that bar — `(44 − 14) / 2 ≈ 15` — and inset it ~19px from
// the left edge (matching the macOS default), so the header's left padding
// clears the cluster. See `ChatLayoutHeader`'s Electron branch in the
// renderer for the matching toolbar height + left inset.
//
// Compact / pre-app surfaces (onboarding, the `/account/*` auth screens) have
// no such title bar, so they keep the system-default position. Those surfaces
// drive `setOnboarding(true)`; the main app drives `setOnboarding(false)`.
const MAIN_TRAFFIC_LIGHT_POSITION = { x: 19, y: 15 } as const;

// Align the macOS traffic lights with the active layout. The compact
// onboarding / auth surfaces pass `compact: true` to reset the cluster to the
// system default (`null`); the main app passes `compact: false` to centre it
// in the inline title bar. macOS-only API — the desktop app only ships on
// macOS — but `setWindowButtonPosition` is a harmless no-op shape elsewhere.
const applyTrafficLightPosition = (
  win: BrowserWindow,
  compact: boolean,
): void => {
  win.setWindowButtonPosition(
    compact ? null : { ...MAIN_TRAFFIC_LIGHT_POSITION },
  );
};

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

// Visibility-change subscribers. Used by the dock state machine to
// follow main-window show/hide/closed transitions without having to
// scan every BrowserWindow and identify "main." `browser-window-created`
// would fire BEFORE `mainWindow = win` lands (the Electron event is
// synchronous inside the constructor), so any identity check at that
// hook is racy. This subscription fires AFTER the assignment so
// `current()` is correct by the time the listener runs.
type VisibilityListener = () => void;
const visibilityListeners: VisibilityListener[] = [];

export const onMainWindowVisibilityChange = (
  listener: VisibilityListener,
): void => {
  visibilityListeners.push(listener);
};

const fireVisibilityChange = (): void => {
  for (const listener of visibilityListeners) listener();
};

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

const installSameOriginNavigationGuard = (win: BrowserWindow): void => {
  const allowedOrigin = resolveAllowedOrigin();

  win.webContents.on("will-navigate", (event, url) => {
    const decision = decideNavigation(url, allowedOrigin);
    if (decision.kind === "allow") return;
    event.preventDefault();
    if (decision.kind === "external") {
      void shell.openExternal(decision.url);
    }
  });
};

const createMainWindow = (): BrowserWindow => {
  // The prod load target is the renderer base itself (no `/index.html`
  // suffix). The `app://` protocol handler in `index.ts` falls back
  // to `index.html` for paths without a file extension, so this
  // serves the SPA — but with the browser URL staying at `/assistant`,
  // which is where React Router's app-root route matches. Appending
  // `/index.html` would land us at the NotFound route under
  // `/assistant/*`. In dev the URL carries a trailing slash to match
  // Vite's `base`; see `getRendererRootUrl`.
  const loadTarget = getRendererRootUrl(app.isPackaged);

  // Onboarding and the main app share the same sizing: restore the user's
  // saved main-app state — which defaults to maximized (work-area bounds)
  // when nothing has been persisted yet. A saved fullscreen session's
  // `fullscreen` flag rides the spread into the `BrowserWindow` constructor.
  // The window can't be dragged below the 800×600 floor (mirroring the Swift
  // client's `contentMinSize`). The persisted onboarding flag now only drives
  // the traffic-light position (compact surfaces have no inline title bar).
  const onboardingActive = readOnboardingActive();
  const sizing = {
    ...restoreBounds("main", MAIN_DEFAULT_STATE),
    minWidth: MAIN_MIN_SIZE.width,
    minHeight: MAIN_MIN_SIZE.height,
  };

  const win = createWindow({
    // `titleBarStyle: "hidden"` removes the native title bar chrome and its
    // title text (otherwise inherited from the renderer's `<title>` —
    // "Vellum Assistant") while keeping the macOS traffic lights, so the
    // renderer content extends up to the top edge behind them.
    browserWindow: { ...sizing, titleBarStyle: "hidden", show: false },
    navigation: { installGuard: installSameOriginNavigationGuard },
  });

  // Main owns the window title (the active assistant's name). Block the
  // renderer's static `<title>` ("Vellum Assistant") from overriding it via
  // page-title updates, then seed the current name — `installMainWindow`'s
  // `onNameChange` subscription keeps it live as identity loads or changes.
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  win.setTitle(getName() ?? DEFAULT_WINDOW_TITLE);

  // Line the macOS traffic lights up with the renderer's inline title bar for
  // the main app; the compact onboarding / auth window keeps the system
  // default. Done before `show` (the window is created hidden) so there's no
  // flicker of the cluster jumping into place. `setOnboarding` keeps this in
  // sync as the user crosses between compact and main surfaces.
  applyTrafficLightPosition(win, onboardingActive);

  // Both modes share the main-app sizing now, so bounds are persisted
  // unconditionally — a resize during onboarding is a legitimate "main"
  // size and should survive the transition and the next launch.
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

  // Visibility transitions feed the dock state machine (via
  // `onMainWindowVisibilityChange`). Subscribed here — not in the
  // listener — so dock doesn't need to know how to identify "main".
  win.on("show", fireVisibilityChange);
  win.on("hide", fireVisibilityChange);

  win.on("closed", () => {
    // Unblock any pending `await ensureVisible()` so callers that hit
    // the destroyed-before-ready race (network failure during load,
    // user quit mid-load) don't hang forever. The caller's follow-up
    // dispatch then sees `current() === null` and no-ops; that's the
    // right semantics — the user closed the window, nothing should
    // happen.
    ready.resolve();
    if (mainWindow === win) mainWindow = null;
    // Subscribers (dock) re-read `current()` which is now null →
    // `isMainWindowVisible()` returns false.
    fireVisibilityChange();
  });

  win.loadURL(loadTarget).catch((err: unknown) => {
    console.error(`[main-window] loadURL failed for ${loadTarget}:`, err);
  });

  mainWindow = win;
  // Fire AFTER assignment so subscribers see the new window via
  // `current()` if they query it. The window itself isn't visible
  // yet (created with `show: false`); the `show`/`hide` listeners
  // above will drive subsequent transitions.
  fireVisibilityChange();
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
    const win = createMainWindow();
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
 * Switch the main window between the onboarding and main-app layouts. Both
 * share the same sizing (restored bounds, 800×600 minimum) — the only
 * per-mode difference left is the traffic-light position, since the inline
 * title bar exists only on the main-app surface. The mode is persisted so
 * the next launch positions the traffic lights without a flicker.
 * Re-asserting the current mode (the renderer fires this on every
 * navigation) is a cheap no-op past the early return.
 */
export const setOnboarding = (active: boolean): void => {
  const wasActive = readOnboardingActive();
  writeOnboardingActive(active);

  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (active === wasActive) return;

  // Re-centre (or reset) the traffic lights to match the layout we're moving
  // into — the inline title bar exists only on the main-app surface.
  applyTrafficLightPosition(win, active);
};

/**
 * Create the initial main window. Call once from `whenReady`.
 * Idempotent: if a window is already alive, no-op.
 */
let installed = false;
export const installMainWindow = (): void => {
  if (installed) return;
  installed = true;

  // IPC surface for renderer-driven "bring the window forward"
  // actions — used by feature consumers reacting to inbound signals
  // (deep links, future notification clicks, etc.). The renderer
  // wrapper at `clients/web/src/runtime/main-window.ts` calls this; the
  // handler returns void so the caller can `await` without value.
  handle("vellum:mainWindow:ensureVisible", z.tuple([]), async (): Promise<void> => {
    await ensureVisible();
  });

  // Renderer-driven onboarding mode. The renderer is the only side that
  // knows whether the current route is an onboarding step, so it toggles
  // the mode (traffic-light position) on/off as the user navigates.
  handle(
    "vellum:mainWindow:setOnboarding",
    z.tuple([z.boolean()]),
    async ([active]): Promise<void> => {
      setOnboarding(active);
    },
  );

  // Keep the (recreatable) main window's title in sync with the assistant
  // name. `createMainWindow` seeds the title on creation; this updates the
  // live window when the renderer publishes a new identity. Reads the
  // module-scope `mainWindow` at call time so it always targets the current
  // instance after a recreate.
  onNameChange((name) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(name ?? DEFAULT_WINDOW_TITLE);
    }
  });

  void ensureVisible();
};

// Test seam — exported only for unit-test setup. Production code
// uses `installMainWindow` instead.
export const __resetForTesting = (): void => {
  installed = false;
};
