import { BrowserWindow, globalShortcut, screen, type Rectangle } from "electron";
import { z } from "zod";

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle } from "./ipc";

/**
 * Final transcript overlay shown after voice capture completes. This is a
 * movable, non-focus-stealing floating window that can be dismissed explicitly,
 * by Escape, by blur/click-outside, or by its caller-provided auto-dismiss
 * timeout. Voice completion wiring lands in a follow-up PR; this module only
 * owns the window and IPC surface.
 */

const OVERLAY_KIND = "transcription";
const OVERLAY_PATH = "/floating/transcription";
const ESCAPE_ACCELERATOR = "Escape";

const OVERLAY_WIDTH = 520;
const OVERLAY_HEIGHT = 176;
const BOTTOM_MARGIN = 56;

export type TranscriptionOverlayState = {
  transcript: string;
  createdAt: number;
  autoDismissMs: number;
};

const transcriptionOverlayStateSchema = z.object({
  transcript: z.string(),
  createdAt: z.number(),
  autoDismissMs: z.number().nonnegative(),
});

export type TranscriptionOverlayDeps = {
  showOverlay: () => void;
  hideOverlay: () => void;
  forwardState: (state: TranscriptionOverlayState) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type TranscriptionOverlayController = {
  show: (state: TranscriptionOverlayState) => void;
  dismiss: () => void;
  getState: () => TranscriptionOverlayState | null;
};

export const createTranscriptionOverlayController = (
  deps: TranscriptionOverlayDeps,
): TranscriptionOverlayController => {
  let latestState: TranscriptionOverlayState | null = null;
  let autoDismissTimer: unknown = null;

  const clearAutoDismissTimer = (): void => {
    if (autoDismissTimer !== null) {
      deps.clearTimeout(autoDismissTimer);
      autoDismissTimer = null;
    }
  };

  const dismiss = (): void => {
    clearAutoDismissTimer();
    latestState = null;
    deps.hideOverlay();
  };

  const show = (state: TranscriptionOverlayState): void => {
    clearAutoDismissTimer();
    latestState = state;
    deps.forwardState(state);
    deps.showOverlay();

    if (state.autoDismissMs > 0) {
      autoDismissTimer = deps.setTimeout(dismiss, state.autoDismissMs);
    }
  };

  return {
    show,
    dismiss,
    getState: () => latestState,
  };
};

let lastMovedBounds: Rectangle | null = null;
let trackedWindow: BrowserWindow | null = null;
let controller: TranscriptionOverlayController | null = null;
let globalEscapeRegistered = false;

const displayPosition = (): { x: number; y: number } => {
  if (lastMovedBounds) {
    return { x: lastMovedBounds.x, y: lastMovedBounds.y };
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  const display =
    focusedWindow && !focusedWindow.isDestroyed()
      ? screen.getDisplayMatching(focusedWindow.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;

  return {
    x: Math.round(x + (width - OVERLAY_WIDTH) / 2),
    y: Math.round(y + height - OVERLAY_HEIGHT - BOTTOM_MARGIN),
  };
};

const rememberActivePosition = (win: BrowserWindow): void => {
  if (!controller?.getState()) return;
  lastMovedBounds = win.getBounds();
};

const dismissOverlay = (): void => {
  controller?.dismiss();
};

const registerGlobalEscapeDismiss = (): void => {
  if (globalEscapeRegistered) return;
  globalEscapeRegistered = globalShortcut.register(
    ESCAPE_ACCELERATOR,
    dismissOverlay,
  );
};

const unregisterGlobalEscapeDismiss = (): void => {
  if (!globalEscapeRegistered) return;
  globalShortcut.unregister(ESCAPE_ACCELERATOR);
  globalEscapeRegistered = false;
};

const attachWindowLifecycle = (win: BrowserWindow): void => {
  if (trackedWindow === win) return;
  trackedWindow = win;

  win.on("move", () => {
    rememberActivePosition(win);
  });
  win.on("blur", dismissOverlay);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      dismissOverlay();
    }
  });

  const cleanup = (): void => {
    if (trackedWindow === win) {
      trackedWindow = null;
    }
    unregisterGlobalEscapeDismiss();
    if (controller?.getState()) {
      controller.dismiss();
    }
  };
  win.on("closed", cleanup);
  win.webContents.on("destroyed", cleanup);
};

const ensureOverlayWindow = (): BrowserWindow => {
  const win = createFloatingWindow({
    kind: OVERLAY_KIND,
    route: OVERLAY_PATH,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    focusOnShow: false,
    visibleOnAllWorkspaces: true,
    position: displayPosition,
    browserWindow: {
      movable: true,
      minimizable: false,
      maximizable: false,
      hasShadow: true,
    },
  });

  attachWindowLifecycle(win);
  return win;
};

const showOverlay = (): void => {
  ensureOverlayWindow();
  registerGlobalEscapeDismiss();
};

const hideOverlay = (): void => {
  unregisterGlobalEscapeDismiss();
  const win = getFloatingWindow(OVERLAY_KIND);
  if (win) {
    win.hide();
  }
};

const forwardState = (state: TranscriptionOverlayState): void => {
  const win = getFloatingWindow(OVERLAY_KIND);
  if (win) {
    win.webContents.send("vellum:transcriptionOverlay:state", state);
  }
};

let installed = false;

export const installTranscriptionOverlay = (): void => {
  if (installed) return;
  installed = true;

  controller = createTranscriptionOverlayController({
    showOverlay,
    hideOverlay,
    forwardState,
    setTimeout,
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  });

  handle(
    "vellum:transcriptionOverlay:show",
    z.tuple([transcriptionOverlayStateSchema]),
    ([state]) => {
      controller?.show(state);
    },
  );

  handle("vellum:transcriptionOverlay:dismiss", z.tuple([]), () => {
    controller?.dismiss();
  });

  handle("vellum:transcriptionOverlay:getState", z.tuple([]), () =>
    controller?.getState() ?? null,
  );
};
