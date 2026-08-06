import { BrowserWindow, app, screen } from "electron";
import { z } from "zod";

import {
  voiceActivityContentSchema,
  voiceActivityControlSchema,
  voiceActivityStartSchema,
  type VoiceActivityContent,
  type VoiceActivityControl,
  type VoiceActivityStart,
  type VoiceActivityState,
} from "@vellumai/ipc-contract";

import { ensureVisible as ensureMainWindowVisible } from "./main-window";
import { RENDERER_BASE_PROD, getDevRendererBase } from "./app-config";
import { handle, on } from "./ipc";
import { createWindow } from "./windows";
import { restoreBounds, track } from "./window-state";

/**
 * The floating live-voice session surface: the desktop counterpart to the iOS
 * Dynamic Island and Lock Screen activity.
 *
 * A small always-on-top panel carrying what those carry: the assistant's
 * identity, the session phase, the turn's activity line, elapsed time, mute
 * state, and the session's own controls. It exists for the same reason they
 * do: a live microphone whose app is not on screen still needs a readout and
 * a way to act on it.
 *
 * **The panel is its own renderer**, so it does not share the main window's
 * live-voice store. State flows main-window renderer → here → panel renderer,
 * which is why the payload is a flat serializable snapshot rather than a store
 * subscription. It is the same shape the iOS bridge sends, for the same reason.
 * `dictation-overlay-window.ts` is the closest sibling; this differs in living
 * for the length of a call rather than a few seconds, which is what earns it a
 * remembered position and a vibrancy material rather than a fixed HUD slot.
 *
 * **It shows for as long as the session runs, and the user decides when it
 * goes.** An earlier build hid it whenever Vellum came forward, reasoning that
 * the app already renders exactly one control for a live session (the voice
 * room, the composer's voice bar, or the pill; see
 * `voice-session-pill-host.tsx`). That rule cannot survive the window this
 * became: a real window with live traffic lights activates the app when it is
 * clicked, so every press on the panel was a press that hid it. A window the
 * user placed and can close is the simpler contract, and the tray is the way
 * back.
 */

const PANEL_PATH = "/floating/voice-activity";
const WINDOW_STATE_KEY = "voice-activity";

// Wide enough for the assistant's name beside its phase, short enough to sit
// in a screen corner without covering work. The height carries the title bar's
// identity, the phase row, and the controls. The canvas
// is the panel: unlike the dictation HUD there is no CSS shadow to leave room
// for, because a window the user positions themselves is allowed the system's
// own shadow (`hasShadow`).
const PANEL_WIDTH = 320;

// Two heights, because the activity line is usually absent. A window sized for
// its tallest possible content spends most of a call showing a hole where that
// line would be, which is what the first build looked like.
const PANEL_HEIGHT = 96;
const PANEL_HEIGHT_WITH_DETAIL = 116;

const heightFor = (state: VoiceActivityState | null): number =>
  state !== null && state.detail !== ""
    ? PANEL_HEIGHT_WITH_DETAIL
    : PANEL_HEIGHT;

// The collapsed chip: identity, phase and elapsed time, which is what survives
// when the panel is shrunk out of the way. Roughly the island's minimal
// presentation, and the reason minimize is not just a second close.
const CHIP_WIDTH = 168;
const CHIP_HEIGHT = 36;

/** Gap from the work area's top-right corner on the first ever launch. */
const DEFAULT_MARGIN = 16;

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export type VoiceActivityDeps = {
  showPanel: () => void;
  hidePanel: () => void;
  /** Resize the window between its expanded and collapsed shapes. */
  setCollapsed: (collapsed: boolean) => void;
  sendState: (state: VoiceActivityState | null) => void;
  now: () => number;
};

export type VoiceActivityController = {
  start: (start: VoiceActivityStart) => void;
  update: (content: VoiceActivityContent) => void;
  end: () => void;
  /** Hide the window. The session keeps running. */
  dismiss: () => void;
  /** Show it again for the session already running. */
  reopen: () => void;
  setCollapsed: (collapsed: boolean) => void;
  /** The snapshot the panel renders, or `null` when no session is running. */
  currentState: () => VoiceActivityState | null;
};

/**
 * Session lifecycle and window state, separated from the window plumbing so
 * the rules are unit-testable, the same deps-injection shape as
 * `createDictationOverlayController`.
 *
 * **The window is the user's, and the session is the app's.** Closing the
 * window hides a readout; it never ends a call, because the thing a user
 * reaches for when a panel is in their way is the close button, and a close
 * button that hung up would be a trap. The two pieces of state are therefore
 * independent: whether a session exists, and whether the user wants to see it.
 *
 * Dismissal lasts only as long as the session it was aimed at. A closed panel
 * means a live microphone with no floating control, which is the state this
 * surface exists to prevent, so `start` clears it and the next call opens a
 * fresh window rather than silently inheriting a preference the user set once
 * and forgot.
 */
export const createVoiceActivityController = (
  deps: VoiceActivityDeps,
): VoiceActivityController => {
  let session: VoiceActivityState | null = null;
  let dismissed = false;

  const reconcile = (): void => {
    if (session === null || dismissed) {
      deps.hidePanel();
      return;
    }
    deps.showPanel();
  };

  const start = (start: VoiceActivityStart): void => {
    const fresh = session === null;
    // A redundant start updates the running session rather than restarting its
    // clock. The mirror re-syncs on mount and the session controller remounts
    // across layout-level route changes while the store persists, so a second
    // start for a session already on screen is expected traffic, not a new
    // call, and an elapsed timer that jumped back to zero on a route change
    // would be a visible lie about a session that never stopped.
    session =
      session === null
        ? { ...start, startedAt: deps.now(), collapsed: false }
        : { ...session, ...start };
    // Only a genuinely new call reopens a closed panel. A remount is not the
    // user changing their mind.
    if (fresh) {
      dismissed = false;
    }
    reconcile();
    deps.sendState(session);
  };

  const update = (content: VoiceActivityContent): void => {
    // An update with no session is dropped rather than promoted into one: it
    // carries no assistant name and no avatar, so honoring it would put an
    // anonymous panel on screen. In practice this is the tail of a session
    // that has already ended.
    if (session === null) {
      return;
    }
    session = { ...session, ...content };
    deps.sendState(session);
  };

  const end = (): void => {
    session = null;
    // Pushed before the hide, so a panel shown again later in the same launch
    // never paints the previous session's phase for a frame.
    deps.sendState(null);
    reconcile();
  };

  const setCollapsed = (collapsed: boolean): void => {
    if (session === null || session.collapsed === collapsed) {
      return;
    }
    session = { ...session, collapsed };
    // The window resizes before the page is told, so the chip is never drawn
    // into a window still the size of the expanded panel.
    deps.setCollapsed(collapsed);
    deps.sendState(session);
  };

  return {
    start,
    update,
    end,
    dismiss: () => {
      dismissed = true;
      reconcile();
    },
    reopen: () => {
      dismissed = false;
      reconcile();
    },
    setCollapsed,
    currentState: () => session,
  };
};

// ---------------------------------------------------------------------------
// Window plumbing
// ---------------------------------------------------------------------------

let panel: BrowserWindow | null = null;

const panelWindow = (): BrowserWindow | null => {
  if (panel === null) {
    return null;
  }
  if (panel.isDestroyed() || panel.webContents.isDestroyed()) {
    panel = null;
  }
  return panel;
};

/**
 * Where a panel with no remembered position opens: the top-right of the
 * display under the cursor, which is where the user is looking and the corner
 * least likely to hold the window they are working in.
 */
const defaultPosition = (): { x: number; y: number } => {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  return {
    x: Math.round(workArea.x + workArea.width - PANEL_WIDTH - DEFAULT_MARGIN),
    y: Math.round(workArea.y + DEFAULT_MARGIN),
  };
};

/**
 * The panel's opening position: where the user last left it, or the default
 * corner.
 *
 * Only the origin is taken from the saved state. `restoreBounds` also returns
 * a size, and honoring it would let one launch's dimensions outlive a change
 * to `PANEL_WIDTH` / `PANEL_HEIGHT`. The panel is not resizable, so its size
 * is the build's to decide and only its placement is the user's. The saved
 * origin is still clamped into a connected display's work area by
 * `restoreBounds`, so a monitor unplugged between sessions cannot strand it
 * off-screen.
 */
export const openingPosition = (): { x: number; y: number } => {
  const saved = restoreBounds(WINDOW_STATE_KEY, {
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
  });
  if (saved.x === undefined || saved.y === undefined) {
    return defaultPosition();
  }
  return { x: saved.x, y: saved.y };
};

const panelUrl = (): string => {
  const base = app.isPackaged ? RENDERER_BASE_PROD : getDevRendererBase();
  return `${base}${PANEL_PATH}`;
};

/**
 * The panel window, created on first use.
 *
 * **Built directly rather than through `createFloatingWindow`**, which fixes
 * `frame: false`, `transparent: true` and `type: "panel"`. None of those can
 * carry traffic lights: a transparent frameless panel has no window surface
 * for macOS to draw them on, and a non-activating panel would leave them
 * inert. This is a real window that happens to float.
 *
 * The traffic lights are the window controls, so the page draws none of its
 * own. Red hides it (see the `close` interception below), yellow minimizes to
 * the Dock, and green is disabled through `maximizable` and `fullscreenable`:
 * a fixed-size readout has no meaningful zoom, and macOS grays the button out
 * rather than needing it hidden.
 */
const createPanel = (): BrowserWindow => {
  const { x, y } = openingPosition();
  const win = createWindow({
    browserWindow: {
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      x,
      y,
      // Frameless *with* traffic lights, the standard macOS shape for a window
      // that wants no title bar and still wants its controls.
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 10, y: 10 },
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      movable: true,
      show: false,
      hasShadow: true,
      // Focusable: traffic lights on a window that cannot take key status are
      // drawn inert.
      focusable: true,
      acceptFirstMouse: true,
      // The glass. `under-window` samples what is behind the window, which for
      // a surface floating over *other apps* reads as glass rather than as a
      // tinted rectangle. `active` keeps it live while Vellum is in the
      // background, which is most of this window's life.
      //
      // The material is an NSVisualEffectView *behind* the web contents, so it
      // is only ever as visible as those contents are transparent. Electron
      // backs a window with an opaque colour by default, which hides it
      // completely. `quick-input-window.ts` gets there through `transparent`,
      // which this window cannot use without giving up its traffic lights, so
      // it takes the command palette's route instead: a zero-alpha backing
      // colour. The page then paints no background of its own, because the
      // material is the background.
      backgroundColor: "#00000000",
      vibrancy: "under-window",
      visualEffectState: "active",
      roundedCorners: true,
    },
    navigation: "deny-all",
  });

  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  // Red hides the window; it never destroys it and never ends the call. The
  // button a user reaches for when a window is in the way must not hang up on
  // them, and the tray offers the way back while a session is live.
  win.on("close", (event) => {
    if (win.isDestroyed()) {
      return;
    }
    event.preventDefault();
    win.hide();
    voiceActivityController?.dismiss();
  });

  track(WINDOW_STATE_KEY, win);
  panel = win;
  win.on("closed", () => {
    panel = null;
  });

  void win.loadURL(panelUrl());
  return win;
};

const ensurePanel = (): BrowserWindow => {
  const existing = panelWindow();
  if (existing !== null) {
    return existing;
  }
  return createPanel();
};

/**
 * The live controller, for callers outside the IPC surface.
 *
 * The tray needs to reopen a window the user closed, and the tray is built
 * long before any session exists, so it reaches the controller through this
 * rather than being handed one at install.
 */
let voiceActivityController: VoiceActivityController | null = null;

/** Whether a session is running, which is when reopening means anything. */
export const isVoiceActivityRunning = (): boolean =>
  voiceActivityController?.currentState() != null;

/**
 * Show the window again for a session already running.
 *
 * The way back from the red button, which hides the window without ending the
 * call.
 */
export const reopenVoiceActivityPanel = (): void => {
  voiceActivityController?.reopen();
};

let installed = false;

export const installVoiceActivityWindow = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  const controller = createVoiceActivityController({
    showPanel: () => {
      const win = ensurePanel();
      // `showInactive` rather than `show`: the window appears because a
      // session started, which is not a reason to take focus away from
      // whatever the user is doing.
      if (!win.isVisible()) {
        win.showInactive();
      }
    },
    hidePanel: () => {
      const win = panelWindow();
      if (win?.isVisible()) {
        win.hide();
      }
    },
    setCollapsed: (collapsed) => {
      const win = panelWindow();
      if (win === null) {
        return;
      }
      // Anchored top-left, so a panel the user parked against the right edge
      // of a display does not walk left every time it is collapsed.
      const [x, y] = win.getPosition();
      win.setBounds({
        x,
        y,
        width: collapsed ? CHIP_WIDTH : PANEL_WIDTH,
        height: collapsed ? CHIP_HEIGHT : PANEL_HEIGHT,
      });
    },
    sendState: (state) => {
      const win = panelWindow();
      if (win === null) {
        return;
      }
      // Sized to the content before the content arrives, so the activity line
      // never paints into a window too short for it, and its absence never
      // leaves an empty strip. Collapsed windows keep the chip's height.
      const current = state?.collapsed === true ? null : heightFor(state);
      if (current !== null) {
        const [x, y] = win.getPosition();
        const [, height] = win.getSize();
        if (height !== current) {
          win.setBounds({ x, y, width: PANEL_WIDTH, height: current });
        }
      }
      win.webContents.send("vellum:voiceActivity:state", state);
    },
    now: () => Date.now(),
  });

  voiceActivityController = controller;

  on(
    "vellum:voiceActivity:start",
    z.tuple([voiceActivityStartSchema]),
    ([start]) => {
      controller.start(start);
    },
  );

  on(
    "vellum:voiceActivity:update",
    z.tuple([voiceActivityContentSchema]),
    ([content]) => {
      controller.update(content);
    },
  );

  on("vellum:voiceActivity:end", z.tuple([]), () => {
    controller.end();
  });

  /**
   * Deliver a panel press to the session that can act on it.
   *
   * Broadcast rather than addressed, for the same reason the dictation overlay
   * broadcasts its stop: main does not know which renderer owns the session,
   * and the session's own listener is mounted for exactly the session's
   * lifetime, so a press with no owner lands nowhere rather than being
   * misrouted. The panel is excluded because it is the sender.
   */
  on(
    "vellum:voiceActivity:control",
    z.tuple([voiceActivityControlSchema]),
    ([control]: [VoiceActivityControl]) => {
      const panel = panelWindow();
      for (const win of BrowserWindow.getAllWindows()) {
        if (
          win === panel ||
          win.isDestroyed() ||
          win.webContents.isDestroyed()
        ) {
          continue;
        }
        win.webContents.send("vellum:voiceActivity:controlEvent", control);
      }
    },
  );

  on("vellum:voiceActivity:dismiss", z.tuple([]), () => {
    controller.dismiss();
  });

  on("vellum:voiceActivity:setCollapsed", z.tuple([z.boolean()]), ([next]) => {
    controller.setCollapsed(next);
  });

  on("vellum:voiceActivity:activate", z.tuple([]), () => {
    // The return button is a request to go back to the app, the desktop
    // reading of the island's tap-through. The panel stays up behind it: it
    // belongs to the session rather than to the app's backgrounded-ness, and
    // the red button is how the user puts it away.
    void ensureMainWindowVisible();
  });

  // The panel route loads lazily, so states pushed before its subscription
  // registers are dropped by Electron. It pulls this once subscribed.
  handle("vellum:voiceActivity:getState", z.tuple([]), () =>
    controller.currentState(),
  );
};
