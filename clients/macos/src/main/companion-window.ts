import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import {
  voiceActivityContentSchema,
  voiceActivityControlSchema,
  voiceActivityStartSchema,
  type CompanionGrowth,
  type CompanionSurfaceState,
  type VoiceActivityState,
} from "@vellumai/ipc-contract";

import { getAvatarPng, onAvatarChange } from "./avatar";
import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle, on } from "./ipc";
import {
  current as currentMainWindow,
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
} from "./main-window";

/**
 * The always-present companion surface (LUM-3086): the assistant's avatar
 * floating from app launch, expanding on hover into a pill with the voice and
 * type-chat options, and holding that expansion for as long as a call runs.
 *
 * **It is also the desktop's live-voice session surface**, the counterpart to
 * the iOS Dynamic Island and Lock Screen activity. Main holds the session
 * snapshot the window renderer publishes and pushes it down to the surface,
 * which is why a session survives the surface's own renderer reloading: the
 * elapsed clock is anchored on this side.
 *
 * A session is shown on the surface that is already there rather than in a
 * window of its own. One assistant, one place on screen: a separate panel for
 * calls meant the avatar sat inert beside a window describing the call it was
 * supposedly having.
 *
 * **A transparent canvas, not a window that resizes.** The canvas is fixed at
 * the widest extent any state can reach and the pill is drawn inside it, so the
 * circle-to-pill move is CSS and the window never changes size. That is the
 * shape `dictation-overlay-window.ts` uses, and it is what keeps the expansion
 * off the main process entirely.
 *
 * **Non-activating**, through `createFloatingWindow`'s `type: "panel"` and
 * `frame: false` / `transparent: true`. Clicking it must never pull Vellum
 * forward: the surface exists precisely for when the user is working somewhere
 * else.
 *
 * **No vibrancy**, deliberately. See the note at the `browserWindow` options:
 * a window's material fills the window, and this window is a canvas many times
 * the size of the pill.
 */

const COMPANION_KIND = "companion";
const COMPANION_ROUTE = "/floating/companion";

/** The avatar's resting footprint, matching `CompanionSurface`. */
const AVATAR_BOX = 44;

/**
 * The widest the pill gets, matching `FALLBACK_WIDTHS.call` in the renderer.
 *
 * A ceiling rather than a width: the pill measures its own content, so this is
 * what the canvas is sized to hold, and content wider than it is clipped by the
 * window. The call's approval row is the widest thing the surface renders.
 */
const MAX_PILL_WIDTH = 360;

/**
 * How far the pill reaches from the avatar's centre.
 *
 * The avatar holds its place and the body runs off one side of it, so the reach
 * is almost the pill's whole width. The canvas has to hold it in whichever
 * direction main later picks, so it is sized for that reach on both sides.
 */
const MAX_REACH = MAX_PILL_WIDTH - AVATAR_BOX / 2;

/** Room for the pill's shadow, which paints outside its box. */
const CANVAS_PAD = 24;

const CANVAS_WIDTH = MAX_REACH * 2 + CANVAS_PAD * 2;
const CANVAS_HEIGHT = AVATAR_BOX + CANVAS_PAD * 2;

/** Gap from the work area's bottom-right on the first ever launch. */
const DEFAULT_MARGIN = 24;

let growth: CompanionGrowth = "right";

/**
 * The running live-voice session, or `null` when none is.
 *
 * Held here rather than in the surface's renderer because that renderer can
 * load, reload, or be recreated mid-call, and an elapsed clock anchored in it
 * would restart when that happened: the one fact on the surface a user would
 * read as "the call dropped and came back".
 */
let call: VoiceActivityState | null = null;

/**
 * The state the renderer sees, rebuilt on demand.
 *
 * The avatar is read from the cache main already keeps for the Dock and Tray
 * rather than carried separately, so the surface cannot show a different
 * assistant from the icon sitting next to it in the Dock.
 */
const currentState = (): CompanionSurfaceState => {
  const png = getAvatarPng();
  return {
    growth,
    avatarBase64: png === null ? undefined : png.toString("base64"),
    call,
  };
};

/**
 * The session after a `start`, which is not always a new session.
 *
 * A redundant start updates the running call rather than restarting its clock.
 * The mirror re-syncs on mount and the session controller remounts across
 * layout-level route changes while the store persists, so a second start for a
 * call already on screen is expected traffic, and an elapsed timer that jumped
 * back to zero on a route change would be a visible lie about a session that
 * never stopped.
 *
 * Exported for its tests, which is also why it takes `now` rather than reading
 * the clock.
 */
export const callOnStart = (
  current: VoiceActivityState | null,
  start: Omit<VoiceActivityState, "startedAt">,
  now: number,
): VoiceActivityState =>
  current === null ? { ...start, startedAt: now } : { ...current, ...start };

/**
 * The session after an `update`, or `null` when there is nothing to update.
 *
 * An update with no session is dropped rather than promoted into one: it
 * carries no assistant name and no avatar, so honoring it would put an
 * anonymous call on the surface. In practice this is the tail of a session that
 * has already ended.
 */
export const callOnUpdate = (
  current: VoiceActivityState | null,
  content: Partial<VoiceActivityState>,
): VoiceActivityState | null =>
  current === null ? null : { ...current, ...content };

/**
 * Which way the pill grows, from where the avatar actually sits.
 *
 * The body needs `MAX_PILL_WIDTH - AVATAR_BOX` of clearance on the side it
 * grows into. Rightward is the default and leftward is what it flips to when
 * the right edge is too close, so the avatar stays exactly where the user put
 * it instead of the controls running off the display.
 *
 * A display too narrow for either direction still grows right, because the
 * clipping is then unavoidable and the user can drag the surface somewhere it
 * fits.
 */
export const growthFor = (
  avatarCentreX: number,
  workArea: { x: number; width: number },
): CompanionGrowth => {
  const needed = MAX_PILL_WIDTH - AVATAR_BOX;
  const roomRight = workArea.x + workArea.width - avatarCentreX;
  const roomLeft = avatarCentreX - workArea.x;
  if (roomRight < needed && roomLeft >= needed) {
    return "left";
  }
  return "right";
};

/**
 * Where the surface opens with no remembered position: the bottom-right of the
 * display under the cursor, near where the Dock usually is and clear of the
 * window the user is working in.
 *
 * The canvas is much larger than the visible circle, so the position is
 * computed for the avatar and then backed out to the canvas origin. Getting
 * that backwards puts the circle half a screen from where it was meant to be.
 */
const defaultCanvasOrigin = (): { x: number; y: number } => {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const avatarCentreX =
    workArea.x + workArea.width - DEFAULT_MARGIN - AVATAR_BOX / 2;
  const avatarCentreY =
    workArea.y + workArea.height - DEFAULT_MARGIN - AVATAR_BOX / 2;
  return {
    x: Math.round(avatarCentreX - CANVAS_WIDTH / 2),
    y: Math.round(avatarCentreY - CANVAS_HEIGHT / 2),
  };
};

const pushState = (): void => {
  const win = getFloatingWindow(COMPANION_KIND);
  if (win) {
    win.webContents.send("vellum:companion:state", currentState());
  }
};

/** Recompute the growth direction from where the window currently is. */
const refreshGrowth = (): void => {
  const win = getFloatingWindow(COMPANION_KIND);
  if (!win) {
    return;
  }
  const [x, y] = win.getPosition();
  const avatarCentreX = x + CANVAS_WIDTH / 2;
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(avatarCentreX),
    y: Math.round(y + CANVAS_HEIGHT / 2),
  });
  const next = growthFor(avatarCentreX, workArea);
  if (next === growth) {
    return;
  }
  growth = next;
  pushState();
};

/**
 * Clicks pass through the canvas until the renderer says the pointer is over
 * the pill.
 *
 * `forward: true` is what makes that possible: it keeps delivering mouse-move
 * to the page while letting presses through, so the surface can know it is
 * being pointed at without having claimed the whole canvas. Going interactive
 * for the entire canvas unconditionally would swallow clicks across a region
 * many times the size of anything visible.
 */
const setInteractive = (interactive: boolean): void => {
  const win = getFloatingWindow(COMPANION_KIND);
  if (!win || win.isDestroyed()) {
    return;
  }
  if (interactive) {
    win.setIgnoreMouseEvents(false);
    return;
  }
  win.setIgnoreMouseEvents(true, { forward: true });
};

let installed = false;

export const installCompanionWindow = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  on("vellum:companion:setInteractive", z.tuple([z.boolean()]), ([next]) => {
    setInteractive(next);
  });

  // Dragging the surface. The renderer sends deltas rather than absolute
  // positions because it is the side holding the pointer, and main is the side
  // that knows where the window currently is. Moving fires `move`, which
  // recomputes the direction, so dragging toward a screen edge flips the growth
  // before the user gets there.
  on(
    "vellum:companion:moveBy",
    z.tuple([z.number(), z.number()]),
    ([dx, dy]) => {
      const win = getFloatingWindow(COMPANION_KIND);
      if (!win || win.isDestroyed()) {
        return;
      }
      const [x, y] = win.getPosition();
      win.setPosition(Math.round(x + dx), Math.round(y + dy));
    },
  );

  /**
   * Talk, delivered to the renderer that can act on it.
   *
   * The surface is its own renderer and holds no live-voice session, so the
   * press travels through main the way the voice panel's controls do. It goes
   * to the main window rather than the focused one, and rather than to every
   * window: the session lives where `ChatLayout` is mounted, which is that
   * window and no other, and the press arrives while the user is working in
   * some other app entirely, so "focused" would name the wrong target.
   *
   * **A window that exists is not raised, and one that does not is created.**
   * A user reaching for a floating avatar has chosen not to go back to Vellum,
   * and the session shows itself on this surface, so an existing window is left
   * exactly where it was. But closing the main window destroys it while this
   * surface stays on screen, and a command dispatched into that gap lands
   * nowhere: Talk would read as broken. There is no way to host a session
   * without a renderer to host it in, so that case builds one, which
   * necessarily shows it.
   */
  on("vellum:companion:startVoice", z.tuple([]), () => {
    if (currentMainWindow() !== null) {
      dispatchToMain({ kind: "startVoice" });
      return;
    }
    // Resolves once the renderer has loaded and the window has shown, so the
    // command arrives at a page that can receive it.
    void ensureMainWindowVisible().then(() => {
      dispatchToMain({ kind: "startVoice" });
    });
  });

  /**
   * The avatar, pressed: come forward on the conversation the user was last in.
   *
   * `currentConversation` is the command the app already has for exactly this,
   * so the surface asks for it rather than growing a path of its own, and the
   * two degrade the same way. The renderer navigates when it has a conversation
   * to navigate to and does nothing when it does not, which leaves the window
   * simply coming forward. The same is true when the app is somewhere with no
   * chat layout mounted, such as Settings: the command lands nowhere and the
   * window is still raised, which is the smaller half of what was asked and
   * never the wrong thing to do.
   *
   * This *does* raise the app, unlike Talk. It is the one press on the surface
   * whose entire purpose is to go back to Vellum.
   */
  on("vellum:companion:activate", z.tuple([]), () => {
    void ensureMainWindowVisible().then(() => {
      dispatchToMain({ kind: "currentConversation" });
    });
  });

  // -------------------------------------------------------------------------
  // The running session
  //
  // Published by whichever renderer holds it (the main window's live-voice
  // mirror), held here, and pushed down to the surface as part of its state.
  // The same payload the iOS bridge sends to ActivityKit, which is why the
  // types live in the contract package rather than here.
  // -------------------------------------------------------------------------

  on(
    "vellum:voiceActivity:start",
    z.tuple([voiceActivityStartSchema]),
    ([start]) => {
      call = callOnStart(call, start, Date.now());
      pushState();
    },
  );

  on(
    "vellum:voiceActivity:update",
    z.tuple([voiceActivityContentSchema]),
    ([content]) => {
      const next = callOnUpdate(call, content);
      if (next === null) {
        return;
      }
      call = next;
      pushState();
    },
  );

  on("vellum:voiceActivity:end", z.tuple([]), () => {
    if (call === null) {
      return;
    }
    call = null;
    pushState();
  });

  /**
   * Deliver a press on the surface to the session that can act on it.
   *
   * Broadcast rather than addressed, the same shape the dictation overlay uses
   * for its stop: main does not know which renderer owns the session, and the
   * session's own listener is mounted for exactly the session's lifetime, so a
   * press with no owner lands nowhere rather than being misrouted. The surface
   * is excluded because it is the sender.
   */
  on(
    "vellum:voiceActivity:control",
    z.tuple([voiceActivityControlSchema]),
    ([control]) => {
      const surface = getFloatingWindow(COMPANION_KIND);
      for (const win of BrowserWindow.getAllWindows()) {
        if (
          win === surface ||
          win.isDestroyed() ||
          win.webContents.isDestroyed()
        ) {
          continue;
        }
        win.webContents.send("vellum:voiceActivity:controlEvent", control);
      }
    },
  );

  // One avatar feeds every surface, so a change to the Dock icon is a change
  // here too.
  onAvatarChange(pushState);

  // The route loads lazily after the window is created, so a state pushed
  // before its subscription registers is dropped. It pulls this once mounted.
  handle("vellum:companion:getState", z.tuple([]), () => currentState());
};

export const openCompanionWindow = (): void => {
  const win = createFloatingWindow({
    kind: COMPANION_KIND,
    route: COMPANION_ROUTE,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    // The canvas is a click-through sheet until the pointer reaches the pill.
    ignoreMouseEvents: { forward: true },
    position: defaultCanvasOrigin,
    browserWindow: {
      // The window draws no shadow of its own: `hasShadow` would outline the
      // invisible canvas rect rather than the pill inside it. Same reason the
      // dictation overlay turns it off.
      hasShadow: false,
      // **Focusable, unlike the dictation overlay.** `type: "panel"` already
      // makes this non-activating, so clicking it does not bring Vellum
      // forward. `focusable: false` would go further and stop the window taking
      // key status at all, which is right for a surface that is only ever
      // pressed and wrong for this one: it is going to host a text field, and a
      // window that cannot become key cannot receive a keystroke. The honest
      // shape is to grant key status only while that field is open, the way
      // mouse events are already granted only while the pointer is on the pill.
      movable: true,
      minimizable: false,
      maximizable: false,
      backgroundColor: "#00000000",
      // **No `vibrancy` here, deliberately.** A window's material fills the
      // window, and this window is a canvas many times the size of the pill
      // drawn inside it, so glass here paints a frosted rectangle across the
      // desktop rather than a glass pill. Real native glass would mean sizing
      // the window to the pill and resizing it on every expansion, which is the
      // thing the fixed canvas exists to avoid. The pill paints its own
      // background instead, as the dictation overlay does.
    },
  });

  refreshGrowth();
  win.on("move", refreshGrowth);
  // A display added, removed or rearranged moves the edges the direction is
  // measured against without the window itself moving at all.
  screen.on("display-metrics-changed", refreshGrowth);
  screen.on("display-added", refreshGrowth);
  screen.on("display-removed", refreshGrowth);
};
