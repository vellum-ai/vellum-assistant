import { screen } from "electron";
import { z } from "zod";

import type { CompanionAnchor, CompanionSurfaceState } from "@vellumai/ipc-contract";

import { getAvatarPng, onAvatarChange } from "./avatar";
import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle, on } from "./ipc";

/**
 * The always-present companion surface (LUM-3086): the assistant's avatar
 * floating from app launch, expanding on hover into a pill with the voice and
 * type-chat options.
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

/** The widest the pill gets, matching `WIDTHS.call` in the renderer. */
const MAX_PILL_WIDTH = 296;

/**
 * How far the pill can reach from the avatar's centre.
 *
 * Worst case is not bloom. Bloom splits its growth and reaches
 * `MAX_PILL_WIDTH / 2` either side, but an edge-anchored pill puts the avatar
 * at one end and reaches almost the pill's whole width the other way. The
 * canvas has to hold whichever anchor main later picks, so it is sized for the
 * larger.
 */
const MAX_REACH = MAX_PILL_WIDTH - AVATAR_BOX / 2;

/** Room for the pill's shadow, which paints outside its box. */
const CANVAS_PAD = 24;

const CANVAS_WIDTH = MAX_REACH * 2 + CANVAS_PAD * 2;
const CANVAS_HEIGHT = AVATAR_BOX + CANVAS_PAD * 2;

/** Gap from the work area's bottom-right on the first ever launch. */
const DEFAULT_MARGIN = 24;

let anchor: CompanionAnchor = "center";

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
    anchor,
    avatarBase64: png === null ? undefined : png.toString("base64"),
  };
};

/**
 * Which way the pill may grow, from where the avatar actually sits.
 *
 * Bloom needs `(width - AVATAR_BOX) / 2` of clearance either side at the
 * widest state. When a side does not have it the surface flips rather than
 * clips, so the avatar stays where the user put it instead of sliding off the
 * display with the controls the user was reaching for.
 */
export const anchorFor = (
  avatarCentreX: number,
  workArea: { x: number; width: number },
): CompanionAnchor => {
  const needed = (MAX_PILL_WIDTH - AVATAR_BOX) / 2;
  const roomLeft = avatarCentreX - workArea.x;
  const roomRight = workArea.x + workArea.width - avatarCentreX;
  if (roomLeft < needed) {
    return "left";
  }
  if (roomRight < needed) {
    return "right";
  }
  return "center";
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

/** Recompute the anchor from where the window currently is. */
const refreshAnchor = (): void => {
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
  const next = anchorFor(avatarCentreX, workArea);
  if (next === anchor) {
    return;
  }
  anchor = next;
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
  // recomputes the anchor, so dragging toward a screen edge flips the growth
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

  refreshAnchor();
  win.on("move", refreshAnchor);
  // A display added, removed or rearranged moves the edges the anchor is
  // measured against without the window itself moving at all.
  screen.on("display-metrics-changed", refreshAnchor);
  screen.on("display-added", refreshAnchor);
  screen.on("display-removed", refreshAnchor);
};
