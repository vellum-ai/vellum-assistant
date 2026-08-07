import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import type {
  DictationOverlayMessage,
  DictationOverlayState,
} from "@vellumai/ipc-contract";

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle, on } from "./ipc";

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

/**
 * A surface that can draw a dictation session in the overlay's place.
 *
 * Structural rather than an import of the companion surface's own module: this
 * one is loaded by the overlay's unit tests, and the companion window reaches
 * `main-window.ts`, which cannot resolve off-Electron. The real implementation
 * is `companionDictationHost`, injected from `index.ts`.
 */
export interface DictationHost {
  /** Whether this surface is on screen to take a session right now. */
  canHost: () => boolean;
  /** A session is beginning. */
  begin: () => void;
  /** Draw a state. */
  forward: (state: DictationOverlayState) => void;
  /** The session is over. */
  end: () => void;
}

/**
 * The overlay's deps, routed to whichever surface should draw the session.
 *
 * A decorator over the deps rather than a branch inside the state machine: the
 * rules about when a session begins, how long a terminal state lingers and what
 * a `dismiss` may cut short are the same wherever it is drawn, and a second
 * copy of them is how the two surfaces would come to disagree.
 *
 * **The target is latched when the session begins.** Deciding per call would
 * let a surface appearing or disappearing mid-session split it across both:
 * shown on one and hidden on the other, which strands whichever surface never
 * got its end. The window that took the session is the window that finishes it.
 */
export const createRoutedDictationDeps = (
  base: DictationOverlayDeps,
  host: DictationHost | undefined,
): DictationOverlayDeps => {
  let routedToHost = false;
  // Whether the last state drawn ended a dictation, which is what makes the
  // next `recording` a new one rather than a continuation. See the re-begin
  // below.
  let settled = false;

  return {
    ...base,
    showOverlay: () => {
      routedToHost = host?.canHost() === true;
      settled = false;
      if (routedToHost) {
        host?.begin();
        return;
      }
      base.showOverlay();
    },
    forwardState: (state) => {
      if (routedToHost) {
        // **A recording that interrupts a terminal state is a fresh begin.**
        // The controller keeps a session visible while `done` or `error`
        // lingers and folds a new recording into it, so `showOverlay` is not
        // called a second time. For a window that only has to stay put that is
        // exactly right; for one that comes to the cursor it means the second
        // dictation is drawn wherever the first one was. The error linger is
        // three seconds, which is precisely when a user retries somewhere else.
        //
        // `begin` is safe to call again: it keeps the parked spot it already
        // recorded (see `parkedOriginForSnap`), so the surface still returns to
        // where the user left it rather than to the previous cursor.
        if (settled && state.kind === "recording") {
          host?.begin();
        }
        settled = state.kind === "done" || state.kind === "error";
        host?.forward(state);
        return;
      }
      base.forwardState(state);
    },
    hideOverlay: () => {
      settled = false;
      if (routedToHost) {
        routedToHost = false;
        host?.end();
        return;
      }
      base.hideOverlay();
    },
  };
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

const broadcastStopRequested = (): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("vellum:dictationOverlay:stopRequested");
    }
  }
};

const setOverlayInteractive = (interactive: boolean): void => {
  const win = getFloatingWindow(OVERLAY_KIND);
  if (!win || win.isDestroyed()) return;
  if (interactive) {
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
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
};

const hideOverlay = (): void => {
  latestState = null;
  const win = getFloatingWindow(OVERLAY_KIND);
  if (win) {
    setOverlayInteractive(false);
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
    /**
     * A surface that draws the session in this overlay's place while it is on
     * screen, which is what the companion surface does. Injected rather than
     * imported: see {@link DictationHost}.
     */
    host?: DictationHost;
  } = {},
): void => {
  if (installed) return;
  installed = true;

  const controller = createDictationOverlayController(
    createRoutedDictationDeps(
      {
        showOverlay,
        hideOverlay,
        forwardState: sendState,
        setTimeout,
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      options.host,
    ),
  );

  on(
    "vellum:dictationOverlay:setState",
    z.tuple([dictationOverlayMessageSchema]),
    ([message]) => {
      options.onRecordingLifecycle?.(message.kind === "recording");
      controller.handleMessage(message);
    },
  );

  on("vellum:dictationOverlay:requestStop", z.tuple([]), () => {
    broadcastStopRequested();
  });

  on(
    "vellum:dictationOverlay:setInteractive",
    z.tuple([z.boolean()]),
    ([interactive]) => {
      setOverlayInteractive(interactive);
    },
  );

  handle("vellum:dictationOverlay:getState", z.tuple([]), () => latestState);
};
