import { BrowserWindow, type WebContents, app, shell } from "electron";
import { z } from "zod";

import { getRendererRootUrl } from "./app-config";
import { resolveAllowedOrigin } from "./app-origin";
import { advanceAuthFlow, decideNavigation } from "./auth-nav";
import { type VellumCommand } from "./commands";
import { handle } from "./ipc";
import { createWindow } from "./windows";
import {
  readOnboardingActive,
  restoreBounds,
  track as trackWindowState,
  writeOnboardingActive,
} from "./window-state";

// Default content-area size of the onboarding flow, mirroring the macOS
// Swift client's onboarding window (`OnboardingWindow.swift`: `contentRect`
// 440×630). Applied as the *content* size (`useContentSize`) so the usable
// area matches the Swift app's `.fullSizeContentView` content rect rather
// than including the Electron title bar. Unlike the Swift window this is
// only the *default* — the window stays resizable, so a user who wants more
// room can drag it larger.
const ONBOARDING_CONTENT_SIZE = { width: 440, height: 630 } as const;

// Default bounds for the main window once onboarding is done.
const MAIN_DEFAULT_BOUNDS = { width: 1280, height: 800 } as const;

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

// ── Sign-in navigation relaxation ───────────────────────────────────────────
// Platform sign-in runs the OAuth provider chain (WorkOS → Google/Apple → our
// callback) as top-level navigations in the main window. Those are cross-origin,
// so the same-origin guard below would normally eject them to the system
// browser mid-handshake. `beginAuthFlow` (renderer IPC, fired on "Continue
// with …") relaxes the guard for the duration of the flow; it re-arms once the
// flow returns to the app origin after visiting a provider (see `did-navigate`
// below) or after a timeout backstop, so the relaxation can't linger.
const AUTH_FLOW_TIMEOUT_MS = 5 * 60_000;
const authFlowActive = new WeakSet<WebContents>();
const authFlowSawExternal = new WeakSet<WebContents>();
const authFlowTimers = new WeakMap<WebContents, ReturnType<typeof setTimeout>>();

const endAuthFlow = (wc: WebContents): void => {
  authFlowActive.delete(wc);
  authFlowSawExternal.delete(wc);
  const timer = authFlowTimers.get(wc);
  if (timer) {
    clearTimeout(timer);
    authFlowTimers.delete(wc);
  }
};

/**
 * Relax the main window's navigation guard for an in-flight sign-in. Idempotent
 * (resets the timeout). Re-armed by the `did-navigate` handler or the timeout.
 */
export const beginAuthFlow = (): void => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  authFlowActive.add(wc);
  authFlowSawExternal.delete(wc);
  const existing = authFlowTimers.get(wc);
  if (existing) clearTimeout(existing);
  authFlowTimers.set(
    wc,
    setTimeout(() => endAuthFlow(wc), AUTH_FLOW_TIMEOUT_MS),
  );
};

const installSameOriginNavigationGuard = (win: BrowserWindow): void => {
  // Scoped to the main window — popups (OAuth flows etc.) need to
  // redirect between provider domains and our callback origin, so
  // they're left unrestricted. Resolved once per window construction
  // so a `VELLUM_DEV_URL` mutated mid-process can't desync the loader
  // and the guard.
  const allowedOrigin = resolveAllowedOrigin();
  const wc = win.webContents;

  wc.on("will-navigate", (event, url) => {
    const decision = decideNavigation(url, allowedOrigin, authFlowActive.has(wc));
    if (decision.kind === "allow") return;
    event.preventDefault();
    // External http(s) top-level navigations (e.g.
    // `window.location.href = "https://billing.stripe.com/..."`) route to the
    // system browser instead of silently failing. Other schemes stay blocked.
    if (decision.kind === "external") {
      void shell.openExternal(decision.url);
    }
  });

  // Re-arm the relaxed guard once a sign-in returns to the app origin after
  // visiting a provider domain. `did-navigate` reports each committed top-level
  // URL (post-redirect), so it sees the provider page and then the callback.
  wc.on("did-navigate", (_event, url) => {
    if (!authFlowActive.has(wc)) return;
    const { end, sawExternal } = advanceAuthFlow(
      url,
      allowedOrigin,
      authFlowSawExternal.has(wc),
    );
    if (sawExternal) authFlowSawExternal.add(wc);
    if (end) endAuthFlow(wc);
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

  // Onboarding opens at the 440×630 default (matching the Swift client);
  // otherwise restore the user's saved main-app bounds. Both layouts are
  // fully resizable — onboarding just starts smaller. The persisted flag
  // lets a relaunch *during* onboarding rebuild the small window directly
  // (no flash); the absent-flag default is `false` (open large) so we
  // never cramp the `/account/*` screens that render outside RootLayout —
  // a brand-new user entering onboarding briefly sees large then the
  // renderer's `setOnboarding` reconcile shrinks it.
  const onboardingActive = readOnboardingActive();
  const sizing = onboardingActive
    ? { ...ONBOARDING_CONTENT_SIZE, useContentSize: true }
    : restoreBounds("main", MAIN_DEFAULT_BOUNDS);

  // The main window relaxes same-origin navigation during the OAuth sign-in
  // chain, so it hands the seam its own guard rather than the static
  // `deny-all` policy; `window.open` stays governed by the global
  // `web-contents-created` handler in `index.ts`.
  const win = createWindow({
    browserWindow: { ...sizing, show: false },
    navigation: { installGuard: installSameOriginNavigationGuard },
  });

  // Persist bounds only when NOT in onboarding mode. Both layouts are
  // resizable, so resize events fire in either mode — but the small
  // onboarding default must not be saved as the user's "main" size, or
  // their next post-onboarding launch would come up tiny. The mode flag
  // (not resizability, which no longer distinguishes them) is the gate.
  trackWindowState("main", win, () => !readOnboardingActive());

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
 * Switch the main window between the onboarding layout (440×630 default)
 * and the main-app layout. Both are fully resizable; the only difference
 * is the default/restored size. Persists the mode so the next launch's
 * window is constructed at the right size, then resizes the current window
 * if the mode actually changed.
 *
 * The mode of record is the persisted flag (read before the write), not
 * resizability — both layouts are resizable now, so `isResizable()` can no
 * longer distinguish them. Writing the flag *before* the resize means
 * `window-state`'s persistence gate (`!readOnboardingActive()`) already
 * reflects the new mode when the programmatic resize fires its event:
 * the entry shrink is skipped, the exit restore is captured under "main".
 * Re-asserting the current mode (the renderer fires this on every
 * navigation) is a cheap no-op past the early return.
 */
export const setOnboarding = (active: boolean): void => {
  const wasActive = readOnboardingActive();
  writeOnboardingActive(active);

  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (active === wasActive) return;

  if (active) {
    win.setContentSize(
      ONBOARDING_CONTENT_SIZE.width,
      ONBOARDING_CONTENT_SIZE.height,
    );
    win.center();
  } else {
    const bounds = restoreBounds("main", MAIN_DEFAULT_BOUNDS);
    win.setBounds({ width: bounds.width, height: bounds.height });
    if (bounds.x !== undefined && bounds.y !== undefined) {
      win.setPosition(bounds.x, bounds.y);
    } else {
      win.center();
    }
  }
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
  // wrapper at `apps/web/src/runtime/main-window.ts` calls this; the
  // handler returns void so the caller can `await` without value.
  handle("vellum:mainWindow:ensureVisible", z.tuple([]), async (): Promise<void> => {
    await ensureVisible();
  });

  // Renderer-driven onboarding-window sizing. The renderer is the only
  // side that knows whether the current route is an onboarding step, so it
  // toggles the 440×630 onboarding default on/off as the user navigates.
  handle(
    "vellum:mainWindow:setOnboarding",
    z.tuple([z.boolean()]),
    async ([active]): Promise<void> => {
      setOnboarding(active);
    },
  );

  // Renderer-driven sign-in: relax the same-origin navigation guard for the
  // duration of an OAuth flow so the provider chain runs in the main window
  // instead of being ejected to the system browser.
  handle(
    "vellum:mainWindow:beginAuthFlow",
    z.tuple([]),
    async (): Promise<void> => {
      beginAuthFlow();
    },
  );

  void ensureVisible();
};

// Test seam — exported only for unit-test setup. Production code
// uses `installMainWindow` instead.
export const __resetForTesting = (): void => {
  installed = false;
};
