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

import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { ensureVisible as ensureMainWindowVisible } from "./main-window";
import { handle, on } from "./ipc";
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
 * **It shows only while Vellum is not frontmost.** The app already renders
 * exactly one control for a live session (the voice room, the composer's
 * voice bar, or the pill; see `voice-session-pill-host.tsx`), so a panel on
 * top of that would be a second control for the same session. Not-frontmost is
 * the desktop reading of the state an island exists for.
 */

const PANEL_KIND = "voice-activity";
const PANEL_PATH = "/floating/voice-activity";
const WINDOW_STATE_KEY = "voice-activity";

// Wide enough for the assistant's name beside its phase, short enough to sit
// in a screen corner without covering work. The height carries three rows:
// identity and phase, the turn's activity line, and the controls. The canvas
// is the panel: unlike the dictation HUD there is no CSS shadow to leave room
// for, because a window the user positions themselves is allowed the system's
// own shadow (`hasShadow`).
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 124;

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

const panelWindow = (): BrowserWindow | null => getFloatingWindow(PANEL_KIND);

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

/** Whether the geometry tracker has been bound to the current panel window. */
let tracked = false;

const ensurePanel = (): BrowserWindow => {
  const win = createFloatingWindow({
    kind: PANEL_KIND,
    route: PANEL_PATH,
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    // Never steals focus from whatever the user is actually doing. `panel` is
    // a non-activating panel on macOS, so the controls can be clicked without
    // bringing Vellum forward, which for this surface is the entire point.
    focusOnShow: false,
    // Above ordinary windows, below the system's own overlays. The dictation
    // HUD reaches for `screen-saver` because it is transient and modal in
    // spirit; a panel that stays up for the length of a call should not
    // outrank a screen saver.
    alwaysOnTopLevel: "floating",
    browserWindow: {
      // Repositionable, which is the whole reason geometry is persisted. The
      // drag itself comes from the route's `-webkit-app-region: drag`; this
      // only permits the window to move.
      movable: true,
      minimizable: false,
      maximizable: false,
      hasShadow: true,
      // **Without this, every control on this panel is dead on first press.**
      // macOS defaults to swallowing the click that activates an inactive
      // window, delivering only the second one to its content. That rule
      // exists so a stray click on a background app cannot act on it. This
      // panel is the exception the rule was not written for: it is *only ever*
      // on screen while the app is inactive, so every press it receives is a
      // first press, and "click once to wake it, again to mean it" is the
      // whole interaction. The user aimed at Mute; the click is not stray.
      acceptFirstMouse: true,
      // The panel never takes key status, so it never activates the app. That
      // is what stops a press on it from flickering the menu bar to Vellum
      // while leaving every real window behind, and it keeps app activation
      // meaning what the visibility gate reads it as: a real window came
      // forward. Clicking the panel still reaches the page, and foregrounding
      // is now something a click asks for explicitly rather than a side
      // effect of touching the surface. The dictation overlay is non-focusable
      // for the same reason and keeps a working control.
      focusable: false,
      // The glass. `under-window` samples what is behind the panel, which for
      // a surface floating over *other apps* is the material that reads as
      // glass rather than as a tinted rectangle. `active` keeps it live while
      // Vellum is in the background, which for this panel is always.
      vibrancy: "under-window",
      visualEffectState: "active",
      roundedCorners: true,
    },
    // Only on creation. Re-applying on every show would drag the panel back to
    // its saved corner mid-session, undoing a move the user made minutes ago.
    // The position is persisted precisely so it survives.
    position: panelWindow() === null ? openingPosition() : undefined,
  });

  if (!tracked) {
    tracked = true;
    track(WINDOW_STATE_KEY, win);
    win.on("closed", () => {
      tracked = false;
    });
  }

  return win;
};

/**
 * The live controller, for callers outside the IPC surface.
 *
 * The tray needs to reopen a panel the user closed, and the tray is built long
 * before any session exists, so it reaches the controller through this rather
 * than being handed one at install.
 */
let voiceActivityController: VoiceActivityController | null = null;

/** Whether a session is running, which is when reopening means anything. */
export const isVoiceActivityRunning = (): boolean =>
  voiceActivityController?.currentState() != null;

/**
 * Show the panel again for a session already running.
 *
 * The way back from the close button. Without one, closing the panel would
 * leave a live microphone with no floating control until the call ended.
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
      ensurePanel();
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
      panelWindow()?.webContents.send("vellum:voiceActivity:state", state);
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
    // A press on the panel is a request to go back to the app, the desktop
    // reading of the island's tap-through. Raising the main window focuses it,
    // which the visibility gate sees as a real window coming forward, so the
    // panel stands down on its own without this having to hide it.
    void ensureMainWindowVisible();
  });

  // The panel route loads lazily, so states pushed before its subscription
  // registers are dropped by Electron. It pulls this once subscribed.
  handle("vellum:voiceActivity:getState", z.tuple([]), () =>
    controller.currentState(),
  );

};
