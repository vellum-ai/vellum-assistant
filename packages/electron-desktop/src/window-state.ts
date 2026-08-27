import { BrowserWindow, screen, type Rectangle } from "electron";
import Store from "electron-store";

import {
  COMPANION_SIZE_AXES,
  COMPANION_SIZES,
  DEFAULT_COMPANION_SIZE,
  titleBarOverlayThemeSchema,
  type CompanionSize,
  type CompanionSizeAxis,
  type TitleBarOverlayTheme,
} from "@vellumai/ipc-contract";

/**
 * Window-geometry persistence. Kept in its own `electron-store` instance
 * (`window-state.json`) so it doesn't collide with the renderer-facing
 * `settings` store, which has `additionalProperties: false` at the root
 * and a strict per-key schema. Window state is a main-process concern
 * the renderer never reads or writes. It doesn't belong on the
 * `window.vellum.settings.*` bridge.
 *
 * `key` namespaces the stored shape, so future windows (thread pop-outs,
 * About, onboarding) can persist alongside the main window without
 * clobbering each other: `track("main", win)`,
 * `track("thread.<id>", win)`, etc.
 */

interface SavedWindowState extends Rectangle {
  isFullScreen: boolean;
  isMaximized?: boolean;
}

interface StoreSchema {
  windows: Record<string, SavedWindowState>;
  // Whether the main window should open in the onboarding layout (440×630)
  // rather than the full main-app size. Persisted here, not read from the
  // renderer's localStorage onboarding store, so the first window of a
  // launch is built at the right size before the renderer loads. Optional:
  // absent means "not yet decided" (see `readOnboardingActive`).
  onboardingActive?: boolean;
  // Whether the user has hidden the companion surface from the tray. A
  // main-process concern like the rest of this store: launch consults it
  // before any renderer loads. Optional: absent means shown, so the flag
  // records only the opt-out (see `readCompanionHidden`).
  companionHidden?: boolean;
  // Which named size the companion's avatar is drawn at, and which its options
  // pill is. A main-process concern for the same reason the opt-out is: the
  // window is built at a canvas derived from both before any renderer loads.
  // Optional: absent means whatever `readCompanionSize` falls back to.
  companionAvatarSize?: CompanionSize;
  companionOptionsSize?: CompanionSize;
  // The single size a build with one size axis records for the whole surface.
  // `readCompanionSize` falls back to it for an axis with nothing of its own,
  // so an install carrying only this comes up at the size it chose on both
  // axes, and `writeCompanionSize` keeps it current for the one state it can
  // say: both axes on the same size.
  companionSize?: CompanionSize;
  // Whether the companion's one-time introduction has run. Held here rather
  // than in the surface's renderer because that renderer reloads, and a run
  // recorded there would start again from the top every time it did. Optional:
  // absent means it has not run (see `readCompanionIntroSeen`).
  companionIntroSeen?: boolean;
  // How the Windows title-bar overlay's caption buttons are painted, as last
  // published by the renderer's active theme. A main-process concern for the
  // same reason the flags above are: the overlay's colors are constructor
  // options, so the first window of a launch is built with them before any
  // renderer loads. Optional: absent means the system colors (see
  // `readTitleBarOverlayTheme`).
  titleBarOverlay?: TitleBarOverlayTheme;
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
 * deliberate: opening too large is recoverable. Onboarding routes live
 * inside `RootLayout` and the reconcile hook shrinks the window once they
 * render, but opening too small is not, since `/account/*` routes
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
 * Whether the user has hidden the companion surface from the tray's
 * "Show Companion" item. Absent defaults to `false`: the surface
 * is a standing presence, and this flag records only the opt-out.
 */
export const readCompanionHidden = (): boolean =>
  store().get("companionHidden", false);

/**
 * Persist the companion-surface opt-out. No-op when the effective value is
 * unchanged so re-asserting the current state doesn't churn the store file.
 */
export const writeCompanionHidden = (hidden: boolean): void => {
  if (readCompanionHidden() === hidden) {
    return;
  }
  store().set("companionHidden", hidden);
};

/** Where each axis keeps its own chosen size. */
const COMPANION_SIZE_KEYS: Record<
  CompanionSizeAxis,
  "companionAvatarSize" | "companionOptionsSize"
> = {
  avatar: "companionAvatarSize",
  options: "companionOptionsSize",
};

/**
 * A stored value if it is a size this build knows, and `null` otherwise.
 *
 * Validated rather than trusted. This file is a JSON store a user can edit and
 * another build can have written, and the value indexes a table of geometry: an
 * unknown one would size the window from `undefined` and put a canvas of `NaN`
 * on screen.
 */
const knownSize = (stored: CompanionSize | undefined): CompanionSize | null =>
  stored !== undefined && COMPANION_SIZES.includes(stored) ? stored : null;

/** The size an axis has of its own, before any fallback. */
const storedSize = (axis: CompanionSizeAxis): CompanionSize | null =>
  knownSize(store().get(COMPANION_SIZE_KEYS[axis]));

/**
 * Which named size one axis of the companion surface is drawn at.
 *
 * The axis's own key first, then the single size a build with one size axis
 * writes, then the default. That middle step is what keeps an install from
 * being resized under its user: someone who picked `huge` from a menu offering
 * one size meant the thing they were looking at, so they get `huge` on both
 * axes rather than the default on either. Nothing promotes that key onto the
 * per-axis ones, so reading through it is the permanent compatibility path, and
 * the shared key a converged pick leaves behind never outranks an axis's own.
 */
export const readCompanionSize = (axis: CompanionSizeAxis): CompanionSize =>
  storedSize(axis) ??
  knownSize(store().get("companionSize")) ??
  DEFAULT_COMPANION_SIZE;

/**
 * Whether the companion's one-time introduction has already run.
 *
 * Absent defaults to `false`, so an install with nothing recorded gets a run.
 * That is the right way round: the surface appears on the desktop without the
 * user having opened it, and the people most owed an explanation of it are the
 * ones who have not had one.
 */
export const readCompanionIntroSeen = (): boolean =>
  store().get("companionIntroSeen", false);

/**
 * Record that the introduction has been seen. One way only, and no-op when
 * already set: nothing in the app un-sees it, and a run that could be reset by
 * a stray write is a floating panel that starts explaining itself again months
 * later.
 */
export const writeCompanionIntroSeen = (): void => {
  if (readCompanionIntroSeen()) {
    return;
  }
  store().set("companionIntroSeen", true);
};

/**
 * Persist one axis's size. No-op only when that axis's own key already says so.
 *
 * The axis's own key rather than the effective value, because that value falls
 * back to the single size a build with one size axis writes. Someone carrying
 * that legacy size who picks it again on one axis is asking for it to be that
 * axis's own answer, and comparing against the fallback would leave the
 * per-axis key empty for as long as they keep agreeing with it.
 *
 * The shared key follows the pick only where both axes land on the same size,
 * which is the whole of what a build with one size axis can say. Someone who
 * put both at `small` and then opened an older build should find it small,
 * rather than a stale value or the shipped default. Axes that differ leave that
 * key exactly as it was: handing that build one axis's answer for both would
 * turn a user sizing the pill alone into one whose creature changed too.
 */
export const writeCompanionSize = (
  axis: CompanionSizeAxis,
  size: CompanionSize,
): void => {
  if (storedSize(axis) === size) {
    return;
  }
  store().set(COMPANION_SIZE_KEYS[axis], size);
  // The written axis is its own key's answer, so `size` is its effective value
  // without reading the store back for it. Every other axis is read through the
  // same fallback the window is built from, so two axes agreeing by way of the
  // shared key itself counts as agreement.
  const converged = COMPANION_SIZE_AXES.filter((other) => other !== axis).every(
    (other) => readCompanionSize(other) === size,
  );
  if (!converged || knownSize(store().get("companionSize")) === size) {
    return;
  }
  store().set("companionSize", size);
};

/**
 * How the Windows caption buttons are drawn, or `null` when nothing has been
 * published yet, which leaves the overlay on its system colors.
 *
 * Validated on the way out for the same reason the companion's size is: this
 * is a JSON file a user can edit, and the value is handed to Chromium's color
 * parser, which silently keeps the previous color for anything it cannot read.
 */
export const readTitleBarOverlayTheme = (): TitleBarOverlayTheme | null => {
  const parsed = titleBarOverlayThemeSchema.safeParse(
    store().get("titleBarOverlay"),
  );
  return parsed.success ? parsed.data : null;
};

/** Persist how the caption buttons are painted. No-op when unchanged. */
export const writeTitleBarOverlayTheme = (
  theme: TitleBarOverlayTheme,
): void => {
  const current = readTitleBarOverlayTheme();
  if (
    current?.color === theme.color &&
    current?.symbolColor === theme.symbolColor &&
    current?.colorScheme === theme.colorScheme
  ) {
    return;
  }
  store().set("titleBarOverlay", theme);
};

/**
 * What to open with when no state has been persisted for the key yet:
 * either a fixed windowed size (Electron centers it), or `"maximized"`:
 * a normal window filling the primary display's work area. macOS has no
 * sticky maximized window state, so work-area bounds are what "maximized"
 * means there (the green button's zoom), deliberately NOT native
 * fullscreen. A saved state always wins once one exists.
 */
type Defaults = { width: number; height: number } | "maximized";

export interface RestoredWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  /**
   * Present only for a saved native-fullscreen session. Callers spread this
   * into `BrowserWindow` options; Electron treats an explicit
   * `fullscreen: false` as "hide the macOS fullscreen button", which drops
   * `AXFullScreenButton` and makes Control+Command+F a no-op.
   */
  fullscreen?: true;
  maximized?: boolean;
}

const isUsableDimension = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isUsableCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isSavedWindowState = (value: unknown): value is SavedWindowState => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<SavedWindowState>;
  return (
    isUsableCoordinate(state.x) &&
    isUsableCoordinate(state.y) &&
    isUsableDimension(state.width) &&
    isUsableDimension(state.height) &&
    typeof state.isFullScreen === "boolean" &&
    (state.isMaximized === undefined ||
      typeof state.isMaximized === "boolean")
  );
};

/**
 * Resolve the bounds to construct a `BrowserWindow` with, falling through
 * to the supplied defaults when no state has been persisted for `key`.
 *
 * When state IS present, the saved rectangle is matched to the closest
 * still-connected display via `screen.getDisplayMatching` and clamped
 * into that display's work area, so:
 *
 *   - An external monitor that was unplugged since the last run doesn't
 *     leave the window 100% off-screen. It shows up on whatever's left.
 *   - A monitor that shrunk (resolution change) doesn't leave the window
 *     extending past the new edge.
 *
 * For fixed-size defaults, omitting `x` / `y` when no state exists is
 * intentional. Electron centers the window in that case, which is the
 * right first-run UX. The `"maximized"` default carries the work area's
 * own origin instead.
 */
export const restoreBounds = (
  key: string,
  defaults: Defaults,
): RestoredWindowState => {
  const saved = store().get("windows", {})[key];
  if (!isSavedWindowState(saved)) {
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

  return {
    x,
    y,
    width,
    height,
    ...(saved.isFullScreen ? { fullscreen: true as const } : {}),
    ...(saved.isMaximized === undefined
      ? {}
      : { maximized: saved.isMaximized }),
  };
};

/**
 * Persist this window's geometry under `key` so the next launch can
 * restore it. Saves on:
 *
 *   - `close`: synchronous, the normal-exit path. Captures whatever
 *     state the user left the window in.
 *   - `resize` / `move`: debounced 500ms. Covers the crash case where
 *     `close` never fires; users lose at most half a second of drag.
 *
 * Reads `getNormalBounds()` rather than `getBounds()` so a maximized or
 * fullscreen window persists its restored-size geometry instead of the
 * full-display rectangle; otherwise un-maximizing on the next run
 * would leave a tiny window. `getNormalBounds()` also returns the
 * pre-minimize bounds when the window is minimized, so no special
 * handling is needed for the common macOS "minimize to dock, then
 * Cmd+Q" path. `isFullScreen()` is tracked separately; restore only
 * forwards `fullscreen: true` so a windowed session stays fullscreenable.
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
    if (win.isDestroyed()) {
      return;
    }
    if (!shouldPersist()) {
      return;
    }
    const bounds = win.getNormalBounds();
    const existing = store().get("windows", {});
    store().set("windows", {
      ...existing,
      [key]: {
        ...bounds,
        isFullScreen: win.isFullScreen(),
        isMaximized: win.isMaximized(),
      },
    });
  };

  const schedulePersist = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
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
