import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import {
  DICTATION_OVERLAY_GET_STATE,
  DICTATION_OVERLAY_REQUEST_STOP,
  DICTATION_OVERLAY_SET_HIT_REGION,
  DICTATION_OVERLAY_SET_INTERACTIVE,
  DICTATION_OVERLAY_SET_STATE,
  DICTATION_OVERLAY_STATE_EVENT,
  DICTATION_OVERLAY_STOP_REQUESTED,
  type DictationOverlayHitRegion,
  type DictationOverlayMessage,
  type DictationOverlayState,
} from "@vellumai/ipc-contract";

import {
  createFloatingWindow,
  getFloatingWindow,
  repositionFloatingWindow,
} from "./floating-window";
import type { IpcHandle, IpcOn } from "./ipc";
import { createModuleConfiguration } from "./module-configuration";

/**
 * System-wide dictation overlay — a floating panel pinned
 * top-center of the active display that shows the user's words live while
 * they dictate via push-to-talk into another app. Matches the native Swift
 * client's `DictationOverlayWindow`: a small pill that expands with partial
 * transcription during recording, then walks the processing → done / error
 * states before dismissing itself.
 *
 * The renderer that owns the recording session (the chat composer in the
 * main window) publishes lifecycle messages over
 * `vellum:dictationOverlay:setState`; main owns the window and forwards the
 * state to the overlay's own renderer route (`/dictation-overlay` in
 * `clients/web/`, same standalone pattern as Quick Input).
 *
 * `type: "panel"` + `focusable: false` keep the overlay from ever stealing
 * focus from the app being dictated into. The transparent canvas is
 * click-through except while the pointer is over the Stop control.
 */

const OVERLAY_KIND = "dictation-overlay";
const OVERLAY_PATH = "/floating/dictation-overlay";

type AlwaysOnTopLevel = NonNullable<
  Parameters<BrowserWindow["setAlwaysOnTop"]>[1]
>;

export const DICTATION_OVERLAY_ALWAYS_ON_TOP_LEVEL =
  "screen-saver" satisfies AlwaysOnTopLevel;

// The window is a fixed-size transparent canvas larger than the visible
// pill: the page renders the pill top-centered and sized to content, with
// padding so its CSS shadow has room to paint (the window itself draws no
// shadow — `hasShadow` would outline the invisible canvas rect).
const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 160;

// The page pads the pill by 16 px (`p-4`); align the transparent canvas with
// the top of the work area so the visible pill lands 16 px below the menu bar.
const CANVAS_TOP_INSET = 16;
const PILL_TOP_OFFSET = 16;

/** How long the success state stays up before the overlay hides. */
export const DONE_HIDE_MS = 800;

/** How long error states stay up — mirrors the recording store's 3 s. */
export const ERROR_HIDE_MS = 3000;

export type {
  DictationOverlayHitRegion,
  DictationOverlayMessage,
  DictationOverlayState,
};

export interface DictationOverlayWindowDependencies {
  closeOnHide?: boolean;
  /**
   * Poll the cursor from main and hit-test it against the renderer-reported
   * Stop region, toggling interactivity directly. Windows workaround:
   * Electron forwards mouse moves to a click-through window
   * (`setIgnoreMouseEvents(true, { forward: true })`) through a low-level
   * hook that posts to a child HWND cached once at window creation and
   * never refreshed (electron/electron#15376, #49982; fix pending in
   * #52633), and the hook is blind while an elevated window is in front
   * (#33281). Either way the page never sees the pointer reach the Stop
   * button, never asks to become interactive, and the click falls through
   * to the app behind. `webContents.sendInputEvent` is no fix: it requires
   * a focused window, and this one is deliberately unfocusable.
   */
  pollCursorForHover?: boolean;
  /** Diagnostic sink for overlay lifecycle and hit-test decisions. */
  log?: (message: string) => void;
  handle: IpcHandle;
  on: IpcOn;
}

const configuration =
  createModuleConfiguration<DictationOverlayWindowDependencies>(
    "Dictation overlay window module",
  );
export const configureDictationOverlayWindow = configuration.configure;

const dictationOverlayMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recording"),
    transcription: z.string(),
    audioLevel: z.number().min(0).max(1).optional(),
  }),
  z.object({ kind: z.literal("processing") }),
  z.object({ kind: z.literal("done") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("dismiss") }),
]);

const dictationOverlayHitRegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
});

export type DictationOverlayDeps = {
  showOverlay: () => void;
  hideOverlay: () => void;
  forwardState: (state: DictationOverlayState) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * Session state machine, separated from the window plumbing so the
 * auto-hide rules are unit-testable (same deps-injection shape as
 * `textInsertion.ts`).
 *
 * A session begins on the first displayable state after idle and ends when
 * the overlay hides. It is shown for both in-app and global dictation so the
 * recording treatment stays consistent with the native macOS dictation HUD.
 */
export const createDictationOverlayController = (
  deps: DictationOverlayDeps,
): { handleMessage: (message: DictationOverlayMessage) => void } => {
  let session: "none" | "visible" = "none";
  let hideTimer: unknown = null;

  const clearHideTimer = (): void => {
    if (hideTimer !== null) {
      deps.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const endSession = (): void => {
    clearHideTimer();
    session = "none";
    deps.hideOverlay();
  };

  const handleMessage = (message: DictationOverlayMessage): void => {
    if (message.kind === "dismiss") {
      if (session === "none") {
        return;
      }
      // Terminal states own their dismissal timing (done flashes briefly,
      // errors linger) — the recording store's idle transition arrives
      // earlier and must not cut them short.
      if (hideTimer !== null) {
        return;
      }
      endSession();
      return;
    }

    if (session === "none") {
      session = "visible";
      deps.showOverlay();
    }

    clearHideTimer();
    deps.forwardState(message);
    if (message.kind === "done") {
      hideTimer = deps.setTimeout(endSession, DONE_HIDE_MS);
    } else if (message.kind === "error") {
      hideTimer = deps.setTimeout(endSession, ERROR_HIDE_MS);
    }
  };

  return { handleMessage };
};

export const CURSOR_HOVER_POLL_MS = 50;

export type CursorHoverPollerDeps = {
  getCursor: () => { x: number; y: number };
  /** Overlay window bounds in screen coordinates, or null once it is gone. */
  getOverlayBounds: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  /** The Stop control's rect in window-relative CSS pixels, if reported. */
  getHitRegion: () => DictationOverlayHitRegion | null;
  /**
   * The overlay page's zoom factor. Window bounds and the cursor are in
   * DIPs while the reported region is in CSS pixels; the two only match at
   * zoom 1, and Chromium persists per-origin zoom, so a zoomed main window
   * carries over to the overlay route.
   */
  getZoomFactor: () => number;
  isInteractive: () => boolean;
  setInteractive: (interactive: boolean) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

/**
 * Stand-in for Electron's broken mouse-move forwarding on Windows (see
 * `pollCursorForHover`): while the overlay is up, watch the cursor and
 * hit-test it against the Stop region the renderer reported, toggling the
 * window's interactivity from main. The renderer cannot run this hit-test
 * itself there: the forwarded mouse moves never arrive, and synthesized
 * input events are ignored by unfocused windows.
 */
export const createCursorHoverPoller = (
  deps: CursorHoverPollerDeps,
): { start: () => void; stop: () => void } => {
  let timer: unknown = null;

  const stop = (): void => {
    if (timer !== null) {
      deps.clearInterval(timer);
      timer = null;
    }
  };

  const tick = (): void => {
    const bounds = deps.getOverlayBounds();
    if (!bounds) {
      stop();
      return;
    }
    const region = deps.getHitRegion();
    let inside = false;
    if (region) {
      const cursor = deps.getCursor();
      const zoom = deps.getZoomFactor();
      const left = bounds.x + region.x * zoom;
      const top = bounds.y + region.y * zoom;
      inside =
        cursor.x >= left &&
        cursor.x < left + region.width * zoom &&
        cursor.y >= top &&
        cursor.y < top + region.height * zoom;
    }
    // Only toggle on change; the renderer's own setInteractive messages
    // (real mouse events, once the window is interactive) stay in charge
    // between ticks.
    if (inside !== deps.isInteractive()) {
      deps.setInteractive(inside);
    }
  };

  const start = (): void => {
    if (timer !== null) {
      return;
    }
    timer = deps.setInterval(tick, CURSOR_HOVER_POLL_MS);
  };

  return { start, stop };
};

// ---------------------------------------------------------------------------
// Window plumbing
// ---------------------------------------------------------------------------

// Latest state forwarded to the overlay renderer. The overlay route loads
// lazily after the window is created, so pushes sent before its `onState`
// subscription registers are dropped by Electron — the route pulls this via
// `vellum:dictationOverlay:getState` once subscribed to catch up.
let latestState: DictationOverlayState | null = null;

const sendState = (state: DictationOverlayState): void => {
  latestState = state;
  const win = getFloatingWindow(OVERLAY_KIND);
  if (win) {
    win.webContents.send(DICTATION_OVERLAY_STATE_EVENT, state);
  }
};

const broadcastStopRequested = (): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(DICTATION_OVERLAY_STOP_REQUESTED);
    }
  }
};

let overlayInteractive = false;
let overlayHitRegion: DictationOverlayHitRegion | null = null;

const debug = (message: string): void => {
  configuration.get().log?.(`[dictation-overlay] ${message}`);
};

const setOverlayInteractive = (interactive: boolean): void => {
  const win = getFloatingWindow(OVERLAY_KIND);
  if (!win || win.isDestroyed()) {
    return;
  }
  if (interactive !== overlayInteractive) {
    debug(`interactive=${interactive}`);
  }
  overlayInteractive = interactive;
  if (interactive) {
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
};

const hoverPoller = createCursorHoverPoller({
  getCursor: () => screen.getCursorScreenPoint(),
  getOverlayBounds: () => getFloatingWindow(OVERLAY_KIND)?.getBounds() ?? null,
  getHitRegion: () => overlayHitRegion,
  getZoomFactor: () =>
    getFloatingWindow(OVERLAY_KIND)?.webContents.getZoomFactor() ?? 1,
  isInteractive: () => overlayInteractive,
  setInteractive: (interactive) => {
    const win = getFloatingWindow(OVERLAY_KIND);
    debug(
      `poll -> ${interactive}: cursor=${JSON.stringify(screen.getCursorScreenPoint())} bounds=${JSON.stringify(win?.getBounds() ?? null)} region=${JSON.stringify(overlayHitRegion)} zoom=${win?.webContents.getZoomFactor() ?? 1}`,
    );
    setOverlayInteractive(interactive);
  },
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
});

export const positionDictationOverlayInWorkArea = (workArea: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } => ({
  x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
  y: Math.round(workArea.y + PILL_TOP_OFFSET - CANVAS_TOP_INSET),
});

const overlayPosition = (): { x: number; y: number } => {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return positionDictationOverlayInWorkArea(display.workArea);
};

export const repositionDictationOverlayWindow = (): void => {
  repositionFloatingWindow(OVERLAY_KIND, overlayPosition);
};

const ensureOverlayWindow = (): BrowserWindow => {
  const win = createFloatingWindow({
    kind: OVERLAY_KIND,
    route: OVERLAY_PATH,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    focusOnShow: false,
    alwaysOnTopLevel: DICTATION_OVERLAY_ALWAYS_ON_TOP_LEVEL,
    ignoreMouseEvents: { forward: true },
    position: overlayPosition,
    browserWindow: {
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      hasShadow: false,
    },
  });

  return win;
};

const showOverlay = (): void => {
  // `createFloatingWindow` uses `showInactive()` when `focusOnShow` is false;
  // never activate the app or steal focus from the dictation target.
  ensureOverlayWindow();
  // A (re)shown window starts click-through regardless of what the last
  // session left behind.
  overlayInteractive = false;
  overlayHitRegion = null;
  const poll = Boolean(configuration.get().pollCursorForHover);
  debug(`show (pollCursorForHover=${poll})`);
  if (poll) {
    hoverPoller.start();
  }
};

const hideOverlay = (): void => {
  debug("hide");
  latestState = null;
  overlayHitRegion = null;
  hoverPoller.stop();
  const win = getFloatingWindow(OVERLAY_KIND);
  if (win) {
    setOverlayInteractive(false);
    if (configuration.get().closeOnHide) {
      win.close();
    } else {
      win.hide();
    }
  }
};

let installed = false;

export const installDictationOverlay = (
  options: {
    /**
     * Raw recording-lifecycle tap, true while the renderer reports an
     * active recording. The shell injects its Escape monitor through this
     * callback so this shared window module does not depend on main-window
     * routing. The raw state is intentional: Escape must cancel a recording
     * even when the overlay itself is suppressed.
     */
    onRecordingLifecycle?: (recording: boolean) => void;
  } = {},
): void => {
  if (installed) {
    return;
  }
  installed = true;
  const { handle, on } = configuration.get();

  const controller = createDictationOverlayController({
    showOverlay,
    hideOverlay,
    forwardState: (state) => {
      if (!getFloatingWindow(OVERLAY_KIND)) {
        showOverlay();
      }
      sendState(state);
    },
    setTimeout,
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  on(
    DICTATION_OVERLAY_SET_STATE,
    z.tuple([dictationOverlayMessageSchema]),
    ([message]) => {
      options.onRecordingLifecycle?.(message.kind === "recording");
      controller.handleMessage(message);
    },
  );

  on(DICTATION_OVERLAY_REQUEST_STOP, z.tuple([]), () => {
    debug("stop requested by the overlay page; broadcasting");
    broadcastStopRequested();
  });

  on(
    DICTATION_OVERLAY_SET_INTERACTIVE,
    z.tuple([z.boolean()]),
    ([interactive]) => {
      setOverlayInteractive(interactive);
    },
  );

  on(
    DICTATION_OVERLAY_SET_HIT_REGION,
    z.tuple([dictationOverlayHitRegionSchema.nullable()]),
    ([region]) => {
      debug(`hit region ${region ? JSON.stringify(region) : "cleared"}`);
      overlayHitRegion = region;
    },
  );

  handle(DICTATION_OVERLAY_GET_STATE, z.tuple([]), () => latestState);
};
