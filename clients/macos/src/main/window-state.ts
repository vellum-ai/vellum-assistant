import { BrowserWindow, screen, type Rectangle } from "electron";
import Store from "electron-store";

/**
 * Window-geometry persistence. Kept in its own `electron-store` instance
 * (`window-state.json`) so it doesn't collide with the renderer-facing
 * `settings` store, which has `additionalProperties: false` at the root
 * and a strict per-key schema. Window state is a main-process concern
 * the renderer never reads or writes — it doesn't belong on the
 * `window.vellum.settings.*` bridge.
 *
 * `key` namespaces the stored shape, so future windows (thread pop-outs,
 * About, onboarding) can persist alongside the main window without
 * clobbering each other — `track("main", win)`,
 * `track("thread.<id>", win)`, etc.
 */

interface SavedWindowState extends Rectangle {
  isFullScreen: boolean;
}

interface StoreSchema {
  windows: Record<string, SavedWindowState>;
  // Whether the main window should open in the onboarding layout (440×630)
  // rather than the full main-app size. Persisted here — not read from the
  // renderer's localStorage onboarding store — so the first window of a
  // launch is built at the right size before the renderer loads. Optional:
  // absent means "not yet decided" (see `readOnboardingActive`).
  onboardingActive?: boolean;
}

let instance: Store<StoreSchema> | null = null;

const store = (): Store<StoreSchema> => {
  if (!instance) {
    instance = new Store<StoreSchema>({
      name: "window-state",
      defaults: { windows: {} },
    });
  }
  return instance;
};

/**
 * Whether the main window should open in onboarding (440×630) mode.
 *
 * The flag is the source of truth once written. When it's absent we
 * default to `false` (open the full main-app size). The bias is
 * deliberate: opening too large is recoverable — onboarding routes live
 * inside `RootLayout` and the reconcile hook shrinks the window once they
 * render — but opening too small is not, since `/account/*` routes
 * (login, signup, OAuth callbacks) render outside `RootLayout` and never
 * call the hook, so a too-small window there would stay cramped. The app
 * is built for the larger size, so we err large and let onboarding shrink
 * itself.
 */
export const readOnboardingActive = (): boolean =>
  store().get("onboardingActive", false);

/**
 * Persist the onboarding-window-mode flag. No-op when the effective value
 * is unchanged so a renderer that re-asserts the current mode on every
 * navigation doesn't churn the store file.
 */
export const writeOnboardingActive = (active: boolean): void => {
  if (readOnboardingActive() === active) return;
  store().set("onboardingActive", active);
};

/**
 * What to open with when no state has been persisted for the key yet:
 * either a fixed windowed size (Electron centers it), or `"maximized"` —
 * a normal window filling the primary display's work area. macOS has no
 * sticky maximized window state, so work-area bounds are what "maximized"
 * means there (the green button's zoom) — deliberately NOT native
 * fullscreen. A saved state always wins once one exists.
 */
type Defaults = { width: number; height: number } | "maximized";

export interface RestoredWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  fullscreen?: boolean;
}

/**
 * Resolve the bounds to construct a `BrowserWindow` with, falling through
 * to the supplied defaults when no state has been persisted for `key`.
 *
 * When state IS present, the saved rectangle is matched to the closest
 * still-connected display via `screen.getDisplayMatching` and clamped
 * into that display's work area, so:
 *
 *   - An external monitor that was unplugged since the last run doesn't
 *     leave the window 100% off-screen — it shows up on whatever's left.
 *   - A monitor that shrunk (resolution change) doesn't leave the window
 *     extending past the new edge.
 *
 * For fixed-size defaults, omitting `x` / `y` when no state exists is
 * intentional — Electron centers the window in that case, which is the
 * right first-run UX. The `"maximized"` default carries the work area's
 * own origin instead.
 */
export const restoreBounds = (
  key: string,
  defaults: Defaults,
): RestoredWindowState => {
  const saved = store().get("windows", {})[key];
  if (!saved) {
    if (defaults === "maximized") {
      return { ...screen.getPrimaryDisplay().workArea };
    }
    return defaults;
  }

  const display = screen.getDisplayMatching(saved);
  const wa = display.workArea;

  const width = Math.min(saved.width, wa.width);
  const height = Math.min(saved.height, wa.height);
  const x = Math.max(wa.x, Math.min(saved.x, wa.x + wa.width - width));
  const y = Math.max(wa.y, Math.min(saved.y, wa.y + wa.height - height));

  return { x, y, width, height, fullscreen: saved.isFullScreen };
};

/**
 * Persist this window's geometry under `key` so the next launch can
 * restore it. Saves on:
 *
 *   - `close` — synchronous, the normal-exit path. Captures whatever
 *     state the user left the window in.
 *   - `resize` / `move` — debounced 500ms. Covers the crash case where
 *     `close` never fires; users lose at most half a second of drag.
 *
 * Reads `getNormalBounds()` rather than `getBounds()` so a maximized or
 * fullscreen window persists its restored-size geometry instead of the
 * full-display rectangle — otherwise un-maximizing on the next run
 * would leave a tiny window. `getNormalBounds()` also returns the
 * pre-minimize bounds when the window is minimized, so no special
 * handling is needed for the common macOS "minimize to dock, then
 * Cmd+Q" path. `isFullScreen()` is tracked separately and passed
 * through to the `BrowserWindow` constructor on restore, so the window
 * comes back in the same display mode it was left in.
 *
 * `shouldPersist` gates each save. It defaults to always-on, but callers
 * that reuse one window across multiple layouts (the main window's
 * onboarding vs. main modes) pass a predicate so a transient layout's
 * size isn't saved under this key. Evaluated at save time, not bind time,
 * so it reflects the current mode.
 */
export const track = (
  key: string,
  win: BrowserWindow,
  shouldPersist: () => boolean = () => true,
): void => {
  const SAVE_DEBOUNCE_MS = 500;
  let saveTimer: NodeJS.Timeout | null = null;

  const persist = (): void => {
    if (win.isDestroyed()) return;
    if (!shouldPersist()) return;
    const bounds = win.getNormalBounds();
    const existing = store().get("windows", {});
    store().set("windows", {
      ...existing,
      [key]: { ...bounds, isFullScreen: win.isFullScreen() },
    });
  };

  const schedulePersist = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS);
  };

  win.on("resize", schedulePersist);
  win.on("move", schedulePersist);
  win.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persist();
  });
};
