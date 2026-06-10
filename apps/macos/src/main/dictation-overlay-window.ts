import { BrowserWindow, app, screen } from "electron";
import { z } from "zod";

import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { on } from "./ipc";
import { createWindow } from "./windows";

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

const overlayUrl = (): string => {
  const base = app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase();
  return `${base}${OVERLAY_PATH}`;
};

let overlayWindow: BrowserWindow | null = null;

// Latest state forwarded to the overlay renderer, replayed on
// `did-finish-load` so the session that triggers the window's creation
// isn't lost to the route-load race.
let latestState: DictationOverlayState | null = null;

const sendState = (state: DictationOverlayState): void => {
  latestState = state;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("vellum:dictationOverlay:state", state);
  }
};

const positionOverlay = (win: BrowserWindow): void => {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width } = display.workArea;
  win.setPosition(
    Math.round(x + (width - OVERLAY_WIDTH) / 2),
    Math.round(y + PILL_TOP_OFFSET - CANVAS_TOP_INSET),
  );
};

const ensureOverlayWindow = (): BrowserWindow => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const win = createWindow({
    browserWindow: {
      type: "panel",
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      show: false,
      hasShadow: false,
    },
    navigation: "deny-all",
  });

  // Display surface only — clicks fall through to whatever is underneath,
  // so the transparent canvas margin never intercepts input.
  win.setIgnoreMouseEvents(true);
  // Dictation targets whatever app the user is in, including fullscreen
  // Spaces — let the overlay appear there too.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  win.webContents.on("did-finish-load", () => {
    if (latestState) {
      win.webContents.send("vellum:dictationOverlay:state", latestState);
    }
  });

  win.on("closed", () => {
    overlayWindow = null;
  });

  void win.loadURL(overlayUrl());
  overlayWindow = win;
  return win;
};

const showOverlay = (): void => {
  const win = ensureOverlayWindow();
  positionOverlay(win);
  // Never `show()` — that would activate the app and steal focus from the
  // app being dictated into.
  win.showInactive();
};

const hideOverlay = (): void => {
  latestState = null;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
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
};
