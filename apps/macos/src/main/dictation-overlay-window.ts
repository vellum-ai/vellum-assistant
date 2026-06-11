import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import type {
  DictationOverlayMessage,
  DictationOverlayState,
} from "@vellumai/ipc-contract";

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle, on } from "./ipc";

/**
 * System-wide dictation overlay — a floating, click-through panel pinned
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
 * `apps/web/`, same standalone pattern as Quick Input).
 *
 * `type: "panel"` + `focusable: false` keep the overlay from ever stealing
 * focus from the app being dictated into, and the window is fully
 * click-through — it's a display surface only.
 */

const OVERLAY_KIND = "dictation-overlay";
const OVERLAY_PATH = "/floating/dictation-overlay";

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

export type { DictationOverlayMessage, DictationOverlayState };

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
      if (session === "none") return;
      // Terminal states own their dismissal timing (done flashes briefly,
      // errors linger) — the recording store's idle transition arrives
      // earlier and must not cut them short.
      if (hideTimer !== null) return;
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
    win.webContents.send("vellum:dictationOverlay:state", state);
  }
};

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

const ensureOverlayWindow = (): BrowserWindow => {
  const win = createFloatingWindow({
    kind: OVERLAY_KIND,
    route: OVERLAY_PATH,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    focusOnShow: false,
    ignoreMouseEvents: true,
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
};

const hideOverlay = (): void => {
  latestState = null;
  const win = getFloatingWindow(OVERLAY_KIND);
  if (win) {
    win.hide();
  }
};

let installed = false;

export const installDictationOverlay = (
  options: {
    /**
     * Raw recording-lifecycle tap, true while the renderer reports an
     * active recording. Feeds the escape monitor (injected from `index.ts`
     * rather than imported — pulling `escape-monitor`'s module graph in
     * here would drag `main-window` into this module's unit tests). Raw
     * rather than suppression-aware on purpose: Esc must cancel a
     * recording even when the overlay itself is suppressed.
     */
    onRecordingLifecycle?: (recording: boolean) => void;
  } = {},
): void => {
  if (installed) return;
  installed = true;

  const controller = createDictationOverlayController({
    showOverlay,
    hideOverlay,
    forwardState: sendState,
    setTimeout,
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  on(
    "vellum:dictationOverlay:setState",
    z.tuple([dictationOverlayMessageSchema]),
    ([message]) => {
      options.onRecordingLifecycle?.(message.kind === "recording");
      controller.handleMessage(message);
    },
  );

  handle("vellum:dictationOverlay:getState", z.tuple([]), () => latestState);
};
