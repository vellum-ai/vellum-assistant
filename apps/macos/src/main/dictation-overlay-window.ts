import { BrowserWindow, screen } from "electron";
import { z } from "zod";

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
const OVERLAY_PATH = "/dictation-overlay";

// The window is a fixed-size transparent canvas larger than the visible
// pill: the page renders the pill top-centered and sized to content, with
// padding so its CSS shadow has room to paint (the window itself draws no
// shadow — `hasShadow` would outline the invisible canvas rect).
const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 160;

// The page pads the pill by 16 px (`p-4`); offset the window so the pill's
// top edge lands 20 px below the work-area top — the Swift overlay's
// position (NSPanel origin `visibleFrame.maxY - 60` for a 40 pt panel).
const CANVAS_TOP_INSET = 16;
const PILL_TOP_OFFSET = 20;

/** How long the success state stays up before the overlay hides. */
export const DONE_HIDE_MS = 800;

/** How long error states stay up — mirrors the recording store's 3 s. */
export const ERROR_HIDE_MS = 3000;

/** States the overlay renderer can display. */
export type DictationOverlayState =
  | { kind: "recording"; transcription: string }
  | { kind: "processing" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** Renderer → main messages: a displayable state or an explicit dismiss. */
export type DictationOverlayMessage =
  | DictationOverlayState
  | { kind: "dismiss" };

const dictationOverlayMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recording"), transcription: z.string() }),
  z.object({ kind: z.literal("processing") }),
  z.object({ kind: z.literal("done") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("dismiss") }),
]);

export type DictationOverlayDeps = {
  isVellumFocused: () => boolean;
  showOverlay: () => void;
  hideOverlay: () => void;
  forwardState: (state: DictationOverlayState) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * Session state machine, separated from the window plumbing so the
 * suppression and auto-hide rules are unit-testable (same deps-injection
 * shape as `textInsertion.ts`).
 *
 * A session begins on the first displayable state after idle and ends when
 * the overlay hides. Sessions that begin while a Vellum window is focused
 * are suppressed entirely: the composer already shows interim text inline,
 * mirroring the Swift client suppressing the overlay for
 * chat-composer-origin dictation.
 */
export const createDictationOverlayController = (
  deps: DictationOverlayDeps,
): { handleMessage: (message: DictationOverlayMessage) => void } => {
  let session: "none" | "visible" | "suppressed" = "none";
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
      if (deps.isVellumFocused()) {
        session = "suppressed";
        return;
      }
      session = "visible";
      deps.showOverlay();
    }

    if (session === "suppressed") {
      if (message.kind === "done" || message.kind === "error") {
        session = "none";
      }
      return;
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

const overlayPosition = (): { x: number; y: number } => {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width } = display.workArea;
  return {
    x: Math.round(x + (width - OVERLAY_WIDTH) / 2),
    y: Math.round(y + PILL_TOP_OFFSET - CANVAS_TOP_INSET),
  };
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

export const installDictationOverlay = (): void => {
  if (installed) return;
  installed = true;

  const controller = createDictationOverlayController({
    // Same focus test `textInsertion.ts` uses to decide composer-vs-front-app
    // insertion, so the overlay suppression agrees with where the text lands.
    isVellumFocused: () => BrowserWindow.getFocusedWindow() !== null,
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
      controller.handleMessage(message);
    },
  );

  handle("vellum:dictationOverlay:getState", z.tuple([]), () => latestState);
};
