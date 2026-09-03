import {
  BrowserWindow,
  Menu,
  screen,
  type Display,
  type MenuItemConstructorOptions,
} from "electron";
import { z } from "zod";

import {
  companionContextSchema,
  voiceActivityContentSchema,
  voiceActivityControlSchema,
  voiceActivityStartSchema,
  COMPANION_BASE_MAX_PILL_WIDTH,
  VOICE_START_REQUEST_TTL_MS,
  COMPANION_INTRO_ACTIONS,
  COMPANION_INTRO_BEATS,
  companionBoxFor,
  companionCardSideFor,
  companionGapFor,
  companionNearEdgeFor,
  companionPadFor,
  companionScaleFor,
  WATCH_FLAG,
  type CompanionCardGrowth,
  type CompanionGrowth,
  type CompanionContext,
  type CompanionIntroAction,
  type CompanionIntroBeat,
  type CompanionSize,
  type CompanionSizeAxis,
  type CompanionSurfaceState,
  type VellumCommand,
  type VoiceActivityState,
} from "@vellumai/ipc-contract";
import { companionSizeSubmenus } from "@vellumai/electron-desktop/companion-menu";
import {
  onSettingChange,
  readSetting,
} from "@vellumai/electron-desktop/settings";
import {
  readCompanionHidden,
  readCompanionIntroSeen,
  readCompanionSize,
  writeCompanionIntroSeen,
  writeCompanionSize,
  writeCompanionHidden,
} from "@vellumai/electron-desktop/window-state";

import {
  getAccentHex,
  getAvatarPng,
  getCharacter,
  onAvatarChange,
} from "@vellumai/electron-desktop/avatar";
import {
  getName as getAssistantName,
  onNameChange,
} from "@vellumai/electron-desktop/identity";
import {
  createFloatingWindow,
  getFloatingWindow,
} from "@vellumai/electron-desktop/floating-window";
import { handle, on } from "./ipc";
import {
  current as currentMainWindow,
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
  onMainWindowVisibilityChange,
} from "./main-window";

/**
/**
 * The flag Watch is behind.
 *
 * Its own flag rather than a share of whatever gates the surface, because the
 * surface is a place to talk to the assistant from and Watch is a session that
 * reads the user's screen. They are ready to be offered to people at different
 * moments, and folding one into the other would mean shipping the second the
 * day the first goes out.
 *
 * Absent means off. A fresh install whose window has not synced yet and an
 * environment where the flag was never provisioned both arrive here as
 * nothing, and the thing on the other side of this answer is a control that
 * starts reading the screen: an affordance offered on a guess is one a user
 * can press before anyone has decided they should have it.
 *
 * Read here rather than in the window that draws the control. That window is a
 * floating route with no auth and no flag store that ever settles, so main is
 * the only side of the surface holding a real evaluation, and it travels down
 * on the state push as {@link CompanionSurfaceState.watchEnabled}.
 *
 * The key itself comes from the contract package, because the web app's
 * `toggleWatch` command reads the same evaluation to decide whether a press may
 * start a session. See {@link WATCH_FLAG}.
 */
const isWatchEnabled = (): boolean =>
  readSetting("featureFlags")?.[WATCH_FLAG] === true;

/**
 * The companion surface (LUM-3086): the assistant's avatar floating from app
 * launch, expanding on hover into a pill carrying the ways to reach it, and
 * holding that expansion for as long as a call runs. It stays on screen
 * for the app's whole run unless the user hides it via the tray's "Show
 * Companion" item, a choice that persists across launches
 * (`readCompanionHidden` in `window-state.ts`).
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

/**
 * Everything the window's placement depends on, for one pair of companion
 * sizes.
 *
 * A record rather than a set of module constants because the user picks the
 * sizes and the whole canvas follows them. Passed to the placement
 * rules explicitly rather than read off the module, so they stay pure functions
 * of their inputs and every size is a case a test can state.
 */
export interface CompanionGeometry {
  /** The creature's box, which is the whole of its own scale. */
  avatarBox: number;
  /**
   * The pill's box, which is the scale of everything that is not the creature.
   */
  optionsBox: number;
  /** The canvas, sized to hold the largest state in either direction. */
  canvasWidth: number;
  canvasHeight: number;
  /** How much canvas the card's side of the avatar needs, shadow included. */
  riseAbove: number;
  /**
   * How much the other side needs: the avatar, whatever of the pill reaches
   * back past it, and the shadow.
   */
  dropBelow: number;
  /**
   * The pill's far edge at its widest, measured from the avatar's centre.
   *
   * Whole points, as every number here is: the window is placed and sized in
   * them, and the avatar stands on the line between the two offsets and on the
   * canvas's own centre line.
   */
  maxReach: number;
}

/**
 * The canvas for a pair of named sizes.
 *
 * Each name goes through its own axis's table ({@link companionBoxFor}), so the
 * same name on both axes is a creature and a pill a notch apart rather than two
 * boxes of one size.
 *
 * The asymmetry between {@link CompanionGeometry.riseAbove} and `dropBelow` is
 * the point of the shape. Sizing both sides for the card, which is what pinning
 * the avatar to the canvas's centre amounts to, spends the card's whole height
 * on a side that never draws anything taller than the pill, and macOS
 * refuses a window origin above the top of the work area, so that spend is
 * exactly how far short of the top the avatar would stop.
 *
 * The canvas is sized for the tallest state rather than resized on the phase,
 * the same bargain the width makes. A canvas that grew with the card would move
 * the window under the pointer mid-press and put the expansion back on the main
 * process, which is what the fixed canvas exists to avoid. It *is* resized when
 * the user picks a different size on either axis, which is a deliberate,
 * one-off event rather than something that happens mid-gesture.
 */
export const geometryFor = (
  avatar: CompanionSize,
  options: CompanionSize,
): CompanionGeometry => {
  const avatarBox = companionBoxFor("avatar", avatar);
  const optionsBox = companionBoxFor("options", options);
  const pad = companionPadFor(avatarBox, optionsBox);
  const gap = companionGapFor(avatarBox, optionsBox);
  const maxPillWidth =
    COMPANION_BASE_MAX_PILL_WIDTH * companionScaleFor(optionsBox);
  // The avatar holds its place and the pill hangs off one side of it across the
  // gap, so the reach is the avatar's half box, the gap, and the widest pill.
  // The canvas has to hold it in whichever direction main later picks, so it is
  // sized for both sides, and `growthFor` picks that direction by the same
  // number. Whole points like everything else published here: the options
  // sizes below the authored box are not whole multiples of it, and a reach
  // carrying a repeating fraction is a canvas edge that lands between points.
  const maxReach = Math.round(avatarBox / 2 + gap + maxPillWidth);
  // Both distances come from the contract, which is where the renderer reads
  // them too: main places the window by them and the renderer anchors the
  // surface by them, so a second copy of either is the avatar drawn somewhere
  // main did not put it. Each already answers for both card directions, which
  // is what lets a flip move the canvas rather than resize it.
  const dropBelow = companionNearEdgeFor(avatarBox, optionsBox);
  const canvasHeight = Math.round(
    companionCardSideFor(avatarBox, optionsBox) + dropBelow,
  );
  // The near edge is taken exactly as the contract states it and the card's
  // side absorbs the rounding, because the renderer names the card's edge with
  // `100%` and steps back from it by that near edge. Rounding the other way
  // round would leave main placing the window by one line and the renderer
  // drawing the creature on another, and a card side is a ceiling with slack in
  // it where a near edge is the line itself.
  const riseAbove = canvasHeight - dropBelow;
  return {
    avatarBox,
    optionsBox,
    // Twice a whole half rather than a whole total. The renderer puts the
    // avatar on the canvas's centre line, so an odd width would stand the
    // creature on a half point and a resize would not land back on it.
    canvasWidth: Math.round(maxReach + pad) * 2,
    canvasHeight,
    riseAbove,
    dropBelow,
    maxReach,
  };
};

/** Gap from the work area's bottom edge on the first ever launch. */
const DEFAULT_MARGIN = 24;

let growth: CompanionGrowth = "right";

/**
 * Which way the card unfurls, and so where the avatar sits inside the canvas.
 *
 * Held beside {@link growth} and for the same reason: it is a fact about the
 * window's position, which is main's to know, and the renderer has to be told
 * it to draw the avatar where the window was actually put.
 */
let cardGrowth: CompanionCardGrowth = "up";

/**
 * The canvas the surface is currently drawn in.
 *
 * Read from the store at startup and replaced when the user picks a different
 * size. Held rather than derived per call because it is what every position
 * computed here is measured in, and reading the store on each mouse-move of a
 * drag would be a file read per frame.
 */
let geometry: CompanionGeometry = geometryFor(
  readCompanionSize("avatar"),
  readCompanionSize("options"),
);

/**
 * The beat of the one-time introduction the surface is on, or `null` when it is
 * not running.
 *
 * Held here rather than in the surface's renderer for the reason the session is:
 * that renderer can reload, be recreated, or load its route late, and a run
 * anchored in it would begin again from the first beat every time it did. Main
 * is also the side holding the "already seen" record, so the two cannot
 * disagree about whether a run is due.
 */
let intro: CompanionIntroBeat | null = null;

/**
 * The introduction after a press, which is `null` once it is over.
 *
 * `dismiss` ends it wherever it is; `next` walks to the following beat and
 * falls off the end into `null`. Resolved against the beat main is actually on
 * rather than one the renderer names, so a press from a renderer a beat behind
 * lands where the user could see that it would.
 *
 * Exported for its tests, as `callOnUpdate` is.
 */
export const introOnAdvance = (
  current: CompanionIntroBeat | null,
  action: CompanionIntroAction,
): CompanionIntroBeat | null => {
  if (current === null || action === "dismiss") {
    return null;
  }
  const next =
    COMPANION_INTRO_BEATS[COMPANION_INTRO_BEATS.indexOf(current) + 1];
  return next ?? null;
};

/**
 * End the introduction and record that it happened.
 *
 * One way only. Every path out of a run goes through here, including the ones
 * that are not a press on it: hiding the surface from the tray is an answer to
 * the introduction as much as skipping it is, and a user who has just put the
 * thing away must not be introduced to it again when they bring it back.
 */
const finishIntro = (): void => {
  if (intro === null) {
    return;
  }
  intro = null;
  writeCompanionIntroSeen();
};

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
 * How long a dial is drawn with no session answering it.
 *
 * The window asked to start a session answers every press it decides on, with
 * a `start` or with an `end`, so this only catches the presses it never gets
 * to decide: a request parked behind a layout that does not mount, or a window
 * that went away mid-preflight. Longer than the request itself can live, by a
 * margin for a preflight that began at the end of that life, so the dial is
 * never gone while a session can still arrive from it: a pill that closed on a
 * call still coming would reopen on the call a moment later, which is the one
 * thing worse than a long dial.
 */
export const COMPANION_DIAL_TIMEOUT_MS = VOICE_START_REQUEST_TTL_MS + 5_000;

/**
 * Whether Talk has been pressed and no session has answered it yet. See
 * {@link CompanionSurfaceState.dialing}.
 *
 * Held here rather than in the surface's renderer for the reason the session
 * is: the press leaves that renderer at once, and a reload across the wait
 * would come back to a pill that had forgotten it was dialing.
 */
let dialing = false;
let dialTimer: ReturnType<typeof setTimeout> | null = null;

const disarmDial = (): void => {
  if (dialTimer !== null) {
    clearTimeout(dialTimer);
    dialTimer = null;
  }
};

/**
 * Whether a Talk press starts a dial.
 *
 * Not while a session is already on the surface: the window that owns it
 * spends the press on the call the user is in, so nothing is coming that a
 * dial could wait for. A session the store holds but the mirror has not yet
 * pushed dials anyway, and the `start` that follows within the beat ends it.
 */
export const dialOnTalk = (current: VoiceActivityState | null): boolean =>
  current === null;

/**
 * Whether the surface is the call's rather than the pill.
 *
 * From the Talk press, not from the session's first phase: the dial is the
 * call's own first beat, and a surface that moved and lit only once the
 * session answered would move a second after the user reached for it.
 */
export const callSurfaceFor = (
  current: VoiceActivityState | null,
  dial: boolean,
): boolean => current !== null || dial;

/**
 * The edge glow drawn around the display while a watch session reads it.
 *
 * The session's, not the call's: a call is a microphone, and the creature's
 * ring already says one is running, where a screen being read is a fact about
 * the whole screen and is framed like one. Its own window rather than a
 * bigger canvas: the canvas is sized once for the pill's reach and the glow
 * wants the whole display, and a click-through sheet the size of a display
 * with the pill's hit-testing inside it would put the forwarded mouse-move on
 * every pixel of the screen.
 */
const WATCH_GLOW_KIND = "companion-watch-glow";
const WATCH_GLOW_ROUTE = "/floating/companion-watch-glow";

/**
 * Where the avatar sat before the call took the surface to the bottom of the
 * display, or `null` outside a call.
 *
 * The call's handlebar defaults to the bottom centre of the screen, the way a
 * meeting's does, and the user is free to drag it from there; when the call
 * ends the pill goes back to where it lived. Held in memory only: the
 * surface's position is never persisted, so there is nothing on disk for a
 * call to corrupt.
 */
let callHome: { x: number; y: number } | null = null;

/**
 * What the app's window last published about the assistant: its name, whether
 * a turn is running, and the sessions it holds.
 *
 * Held here for the same reason the session is: the surface's renderer reloads,
 * and a surface that came back with no name and no session would read as both
 * having been lost.
 */
let context: CompanionContext = {
  assistantName: "",
  working: false,
  watching: false,
  captureCount: 0,
};

/**
 * The state the renderer sees, rebuilt on demand.
 *
 * The avatar is read from the cache main already keeps for the Dock and Tray
 * rather than carried separately, so the surface cannot show a different
 * assistant from the icon sitting next to it in the Dock.
 */
const currentState = (): CompanionSurfaceState => {
  const png = getAvatarPng();
  const character = getCharacter();
  const accentHex = getAccentHex();
  return {
    growth,
    cardGrowth,
    avatarBox: geometry.avatarBox,
    optionsBox: geometry.optionsBox,
    character: character === null ? undefined : character,
    accentHex: accentHex === null ? undefined : accentHex,
    avatarBase64: png === null ? undefined : png.toString("base64"),
    call,
    dialing,
    intro,
    assistantName: context.assistantName,
    working: context.working,
    // `CompanionContext.watching` is optional, so a publisher that omits it is
    // reporting no session of its own. Settled to a boolean here rather than
    // passed through, so the surface reads one shape whatever arrived.
    watching: context.watching === true,
    // Passed through as it arrived, absence included: unlike `watching` this
    // has no resting value to settle to, since every value it can hold is a
    // claim that something is happening.
    watchRetro: context.watchRetro,
    // Settled the same way, and to zero rather than to anything carried over:
    // a publisher that reports no count has taken no reads this surface can
    // vouch for.
    captureCount: context.captureCount ?? 0,
    // Passed through as it arrived, for the reason `watchRetro` is: every value
    // it can hold claims a microphone is doing something.
    dictating: context.dictating,
    // Passed through as it arrived. Bounded by the publisher and again by the
    // schema, so nothing here has to decide how much of it is too much.
    dictationText: context.dictationText,
    // Read on every rebuild rather than captured once, because the evaluation
    // lands after launch: the app's window has to sign in and fetch it first,
    // and a targeting change can move it again while the app runs.
    watchEnabled: isWatchEnabled(),
  };
};

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
 * The room on each side is measured from the avatar's centre, so the clearance
 * the pill needs is measured from there too: the avatar's half box, then the
 * gap, then the widest the pill draws, which is
 * {@link CompanionGeometry.maxReach}.
 * Rightward is the default and leftward is what it flips to when the right edge
 * is too close, so the avatar stays exactly where the user put it instead of
 * the controls running off the display.
 *
 * A display too narrow for either direction still grows right, because the
 * clipping is then unavoidable and the user can drag the surface somewhere it
 * fits.
 */
export const growthFor = (
  avatarCentreX: number,
  workArea: { x: number; width: number },
  geometry: CompanionGeometry,
): CompanionGrowth => {
  const needed = geometry.maxReach;
  const roomRight = workArea.x + workArea.width - avatarCentreX;
  const roomLeft = avatarCentreX - workArea.x;
  if (roomRight < needed && roomLeft >= needed) {
    return "left";
  }
  return "right";
};

/**
 * Which way the card unfurls, from the room the display has above the avatar.
 *
 * The vertical {@link growthFor}. Growing upward
 * needs `riseAbove` of canvas above the avatar's centre, and macOS will
 * not put that canvas above the top of the work area, so near the top of a
 * display the card has to grow the other way instead.
 *
 * Where {@link growthFor} falls back to its designed direction when neither
 * fits, this falls back to the other one, because the two are not paying the
 * same price. A canvas may hang off the left and right of a display freely, so
 * a bad horizontal guess only clips the card. It may not hang off the top, so a
 * bad vertical guess pushes the *avatar* down by the whole reserved height and
 * fences it out of the top of the screen, which is the bug this exists to fix,
 * in miniature. On a display too short for the card either way the card is
 * already lost, and what is worth saving is the mascot's reach.
 */
export const cardGrowthFor = (
  avatarCentreY: number,
  workArea: { y: number; height: number },
  geometry: CompanionGeometry,
): CompanionCardGrowth =>
  avatarCentreY - workArea.y >= geometry.riseAbove ? "up" : "down";

/**
 * Where the avatar's centre sits inside the canvas, measured from its top.
 *
 * The one number the renderer and main have to agree on for the surface to be
 * drawn where the window was put. Published with the direction rather than
 * recomputed on the other side, so there is one derivation of it.
 */
export const avatarOffsetFor = (
  cardGrowth: CompanionCardGrowth,
  geometry: CompanionGeometry,
): number => (cardGrowth === "up" ? geometry.riseAbove : geometry.dropBelow);

/**
 * Where to put the canvas so the avatar lands on a given point, and which way
 * the card unfurls once it is there.
 *
 * Everything is computed in the avatar's coordinates and converted to a window
 * origin at the last step. Working the other way round (nudging the origin and
 * reading the avatar out of it) is what made the direction flip impossible to
 * do mid-drag: the avatar's offset inside the canvas changes with the
 * direction, so the same origin means two different avatar positions, and a
 * drag that crossed the threshold would teleport the mascot by the difference.
 *
 * **The avatar is what is kept on screen, not the canvas.** The canvas reaches
 * hundreds of points past the avatar to hold a pill that is usually not drawn,
 * and clamping that box would fence the avatar into the middle of the display,
 * unable to reach the corner it is meant to rest in.
 *
 * **The origin is never asked for above the work area.** macOS silently refuses
 * such a position and hands back one flush with the work area's top, which
 * moves the avatar somewhere neither side chose. Asking only for positions the
 * window server will honour is what keeps main's idea of where the avatar is
 * equal to where it actually is.
 *
 * Exported for its tests, as {@link growthFor} is, and pure for the same
 * reason: it is the rule that decides whether the surface can be lost.
 */
export const placeCanvas = (
  avatarCentre: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
  geometry: CompanionGeometry,
): { origin: { x: number; y: number }; cardGrowth: CompanionCardGrowth } => {
  // Half the avatar may hang past the edge, so the clamp is to its centre plus
  // a half box. A work area smaller than the avatar would put the maximum below
  // the minimum, which `Math.min` then resolves toward the top-left corner
  // rather than producing a position outside the display.
  const half = geometry.avatarBox / 2;
  const minCentreX = workArea.x + half;
  const maxCentreX = workArea.x + workArea.width - half;
  const minCentreY = workArea.y + half;
  const maxCentreY = workArea.y + workArea.height - half;
  const centreX = Math.min(Math.max(avatarCentre.x, minCentreX), maxCentreX);
  const wantedY = Math.min(Math.max(avatarCentre.y, minCentreY), maxCentreY);

  const cardGrowth = cardGrowthFor(wantedY, workArea, geometry);
  const offset = avatarOffsetFor(cardGrowth, geometry);
  // The last of the three bounds, and the one macOS would otherwise apply
  // itself: the canvas above the avatar has to fit under the work area's top.
  const centreY = Math.max(wantedY, workArea.y + offset);

  return {
    origin: {
      x: Math.round(centreX - geometry.canvasWidth / 2),
      y: Math.round(centreY - offset),
    },
    cardGrowth,
  };
};

/**
 * Where the avatar's centre goes with no remembered position: the bottom
 * centre of the work area, a margin up from its edge. Centred so the pill has
 * room to grow either way, and low so it sits under the window the user is
 * working in rather than over it.
 *
 * Exported for its tests and pure for the same reason as {@link placeCanvas}.
 */
export const defaultAvatarCentre = (
  workArea: { x: number; y: number; width: number; height: number },
  geometry: CompanionGeometry,
): { x: number; y: number } => ({
  x: workArea.x + workArea.width / 2,
  y: workArea.y + workArea.height - DEFAULT_MARGIN - geometry.avatarBox / 2,
});

/**
 * Where the surface opens with no remembered position: the bottom centre of
 * the display under the cursor.
 *
 * The canvas is much larger than the visible circle, so the position is
 * computed for the avatar and then backed out to the canvas origin. Getting
 * that backwards puts the circle half a screen from where it was meant to be.
 */
const defaultCanvasOrigin = (): { x: number; y: number } => {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const placed = placeCanvas(
    defaultAvatarCentre(workArea, geometry),
    workArea,
    geometry,
  );
  cardGrowth = placed.cardGrowth;
  return placed.origin;
};

const pushState = (): void => {
  const state = currentState();
  // The glow reads the same state the surface does, for the same reason the
  // surface holds none of it: one push, two windows, no second idea of which
  // call is running or what colour it is.
  for (const kind of [COMPANION_KIND, WATCH_GLOW_KIND]) {
    const win = getFloatingWindow(kind);
    if (win) {
      win.webContents.send("vellum:companion:state", state);
    }
  }
};

/**
 * Start or end the dial, and push the surface if that changed anything.
 *
 * The bound is armed with the dial and disarmed with it, whichever way it
 * ends, so a session that answers in a second does not leave a timer behind to
 * end a later dial early.
 */
const setDialing = (next: boolean): void => {
  disarmDial();
  if (next) {
    dialTimer = setTimeout(() => {
      dialTimer = null;
      setDialing(false);
    }, COMPANION_DIAL_TIMEOUT_MS);
  }
  if (dialing === next) {
    return;
  }
  dialing = next;
  syncCallSurface();
  pushState();
};

/**
 * Where the avatar's centre currently is, in screen coordinates.
 *
 * Read from the window rather than remembered, because the window is moved by
 * the drag, by a display change, and by the window server, and only one of
 * those three goes through this module.
 */
const avatarCentre = (win: {
  getPosition: () => number[];
}): { x: number; y: number } => {
  const [x, y] = win.getPosition();
  return {
    x: x + geometry.canvasWidth / 2,
    y: y + avatarOffsetFor(cardGrowth, geometry),
  };
};

/**
 * Recompute both growth directions from where the window currently is.
 *
 * The vertical one can change without a drag: a display arriving or leaving, or
 * the menu bar's height changing, moves the work area under a surface that
 * never moved.
 */
const refreshGrowth = (): void => {
  const win = getFloatingWindow(COMPANION_KIND);
  if (!win) {
    return;
  }
  const centre = avatarCentre(win);
  const display = screen.getDisplayNearestPoint({
    x: Math.round(centre.x),
    y: Math.round(centre.y),
  });
  const { workArea } = display;
  // The light follows the surface from display to display. Before the early
  // return below, since a drag across displays need not change either growth.
  if (getFloatingWindow(WATCH_GLOW_KIND) !== null) {
    placeWatchGlow(display);
  }
  const nextGrowth = growthFor(centre.x, workArea, geometry);
  const nextCardGrowth = cardGrowthFor(centre.y, workArea, geometry);
  if (nextGrowth === growth && nextCardGrowth === cardGrowth) {
    return;
  }
  growth = nextGrowth;
  if (nextCardGrowth !== cardGrowth) {
    // The offset moved, so the same origin now means a different avatar
    // position. Put the window back where the avatar was.
    cardGrowth = nextCardGrowth;
    const placed = placeCanvas(centre, workArea, geometry);
    win.setPosition(placed.origin.x, placed.origin.y);
  }
  pushState();
};

/**
 * Put the avatar on a point, clamped into the work area it is measured against.
 *
 * The drag, the call's move to the bottom of the display and the move back
 * all go through here. The card direction is settled before the move, not
 * after: `setPosition` fires `move`, which runs `refreshGrowth`, which reads
 * the avatar's position back out of the window using that variable, so it has
 * to already say which offset the new origin was computed against, or the
 * refresh measures the avatar somewhere it is not and moves the window a
 * second time. The renderer cannot see the intervening frame: the push is a
 * message and the move is immediate.
 */
const moveAvatarTo = (
  win: BrowserWindow,
  centre: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
): void => {
  const placed = placeCanvas(centre, workArea, geometry);
  if (placed.cardGrowth !== cardGrowth) {
    cardGrowth = placed.cardGrowth;
    pushState();
  }
  win.setPosition(placed.origin.x, placed.origin.y);
};

const displayUnder = (point: { x: number; y: number }): Display =>
  screen.getDisplayNearestPoint({
    x: Math.round(point.x),
    y: Math.round(point.y),
  });

/**
 * Light the edge of a display, or move the light to it.
 *
 * The whole display rather than its work area, the way a shared screen is
 * framed: the menu bar draws over the top edge, and a frame that stopped
 * short of it would read as a window's border rather than the screen's.
 *
 * One step below the surface at the same level, so the pill is always drawn
 * over the light and never under it. Click-through with nothing forwarded:
 * there is nothing on it to point at.
 */
const placeWatchGlow = (display: Display): void => {
  const { bounds } = display;
  const existing = getFloatingWindow(WATCH_GLOW_KIND);
  if (existing !== null) {
    const current = existing.getBounds();
    if (
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height
    ) {
      existing.setBounds(bounds);
    }
    return;
  }
  const win = createFloatingWindow({
    kind: WATCH_GLOW_KIND,
    route: WATCH_GLOW_ROUTE,
    width: bounds.width,
    height: bounds.height,
    ignoreMouseEvents: true,
    position: { x: bounds.x, y: bounds.y },
    browserWindow: {
      hasShadow: false,
      focusable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: "#00000000",
    },
  });
  win.setAlwaysOnTop(true, "floating", -1);
};

const closeWatchGlow = (): void => {
  getFloatingWindow(WATCH_GLOW_KIND)?.close();
};

/**
 * Light the display being read, or put the light out, to match what the
 * app's window last said about the session.
 *
 * Idempotent, and run after every change to the context. The display is the
 * one under the avatar, which is where the user's eye already is for this
 * surface's state, or under the cursor when the surface is hidden: the light
 * is the session's rather than the surface's, since a hidden pill is not a
 * screen that has stopped being read.
 */
const syncWatchGlow = (): void => {
  if (context.watching !== true) {
    closeWatchGlow();
    return;
  }
  const win = getFloatingWindow(COMPANION_KIND);
  placeWatchGlow(
    displayUnder(
      win === null ? screen.getCursorScreenPoint() : avatarCentre(win),
    ),
  );
};

/**
 * Make the surface the call's, or give it back to the pill, to match what
 * main is holding.
 *
 * Idempotent, and run after every change to the session or the dial. Into a
 * call: remember where the avatar was and take it to the bottom centre of its
 * display. Out of one: take the avatar home. A surface not on screen has
 * nothing to move.
 */
const syncCallSurface = (): void => {
  const win = getFloatingWindow(COMPANION_KIND);
  if (callSurfaceFor(call, dialing)) {
    if (win === null || callHome !== null) {
      return;
    }
    callHome = avatarCentre(win);
    const display = displayUnder(callHome);
    moveAvatarTo(
      win,
      defaultAvatarCentre(display.workArea, geometry),
      display.workArea,
    );
    return;
  }
  if (callHome === null) {
    return;
  }
  const home = callHome;
  callHome = null;
  if (win === null) {
    return;
  }
  moveAvatarTo(win, home, displayUnder(home).workArea);
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

/**
 * Hand a press on the surface to the renderer that can act on it, without
 * bringing Vellum forward.
 *
 * **A window that exists is not raised, and one that does not is created.** A
 * user reaching for a floating avatar has chosen not to go back to Vellum, and
 * what they asked for shows itself on this surface, so an existing window is
 * left exactly where it was. But closing the main window destroys it while this
 * surface stays on screen, and a command dispatched into that gap lands
 * nowhere: the press would read as broken. There is no way to act without a
 * renderer to act in, so that case builds one, which necessarily shows it.
 */
export const dispatchWithoutRaising = (command: VellumCommand): void => {
  if (currentMainWindow() !== null) {
    dispatchToMain(command);
    return;
  }
  // Resolves once the renderer has loaded and the window has shown, so the
  // command arrives at a page that can receive it.
  void ensureMainWindowVisible().then(() => {
    dispatchToMain(command);
  });
};

/**
 * Come forward on the conversation the user was last in.
 *
 * `currentConversation` is the command the app already has for exactly this,
 * so the surface asks for it rather than growing a path of its own, and the
 * two degrade the same way. The renderer navigates when it has a conversation
 * to navigate to and does nothing when it does not, which leaves the window
 * simply coming forward. Shared by the avatar's press on a call and the
 * surface's menu.
 */
const openVellum = (): void => {
  void ensureMainWindowVisible().then(() => {
    dispatchToMain({ kind: "currentConversation" });
  });
};

let installed = false;

/**
 * The surface's own menu, on a right-click.
 *
 * **Because the tray is the wrong place to look.** The two things a user
 * wants from a floating avatar are to resize it and to make it go away, and the
 * tray offers both from a menu-bar icon that says nothing about the thing they
 * are actually looking at. A press on the object itself is where people reach
 * first.
 *
 * Built in main rather than in the renderer: a menu is a native window, and
 * main is the side that owns both the sizes and the visibility. The size
 * pickers come from the same builder the tray reads, so the two menus cannot
 * drift into describing the same surface differently.
 *
 * A pure template, separately from the press that pops it, because the menu
 * itself is a native window and what is worth stating is the wording and which
 * radio is marked.
 */
export const companionContextMenuTemplate = (
  current: Record<CompanionSizeAxis, CompanionSize>,
  actions: {
    open: () => void;
    setSize: (axis: CompanionSizeAxis, size: CompanionSize) => void;
    hide: () => void;
  },
): MenuItemConstructorOptions[] => [
  {
    // The way back to Vellum from an idle surface. A press on the creature
    // starts a call, so going back to the app is here, first, since it is the
    // one item a user reaches for that is not about the surface itself.
    label: "Open Vellum",
    click: () => {
      actions.open();
    },
  },
  { type: "separator" as const },
  // The size pickers the tray offers too, from the one builder both read. They
  // leave the top level short enough to read at a glance: two headings, and the
  // one item that is not a size.
  ...companionSizeSubmenus(current, actions.setSize),
  { type: "separator" as const },
  {
    // Named for what it does to the thing under the cursor. The tray's item is
    // a checkbox because it is also the way back; here there is a surface in
    // front of the user, so this only has to take it away.
    label: "Hide Companion",
    click: () => {
      actions.hide();
    },
  },
];

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
  //
  // The delta is clamped rather than trusted. A drag that outruns the window,
  // or one whose release this window never saw, arrives here as a single huge
  // jump, and unclamped that jump puts the surface somewhere the user cannot
  // reach it. See `placeCanvas`.
  on(
    "vellum:companion:moveBy",
    z.tuple([z.number(), z.number()]),
    ([dx, dy]) => {
      const win = getFloatingWindow(COMPANION_KIND);
      if (!win || win.isDestroyed()) {
        return;
      }
      // In the avatar's coordinates, not the window's. The avatar is what the
      // hand is holding, and its offset inside the canvas changes when the card
      // direction flips, so a delta applied to the origin would drag the mascot
      // out from under the pointer at the threshold.
      const centre = avatarCentre(win);
      const wanted = { x: centre.x + dx, y: centre.y + dy };
      // Measured against the display the drag is heading for rather than the
      // one it started on, so a surface dragged onto a second display is
      // clamped to that display's edges instead of being held back at the
      // first one's.
      moveAvatarTo(win, wanted, displayUnder(wanted).workArea);
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
   */
  on("vellum:companion:startVoice", z.tuple([]), () => {
    // Drawn before the press is delivered, so the pill answers the hand in
    // the same beat: the session it asks for opens after a network round trip
    // in a window the user cannot see.
    if (dialOnTalk(call)) {
      setDialing(true);
    }
    dispatchWithoutRaising({ kind: "startVoice" });
  });

  /**
   * Watch, delivered to the same renderer Talk's press goes to.
   *
   * One command for both edges rather than a start and a stop. The surface
   * draws a single toggle and holds no session, so the window that owns the
   * session is the only side that can tell which edge a press is; main forwards
   * the press and lets it answer.
   *
   * This does not raise the app, for a sharper version of Talk's reason. The
   * user reached for a floating surface because they are working somewhere
   * else, and here that work is the subject of the session: bringing Vellum
   * forward would cover the very thing the session exists to watch.
   */
  on("vellum:companion:toggleWatch", z.tuple([]), () => {
    dispatchWithoutRaising({ kind: "toggleWatch" });
  });

  /**
   * The answer to the summary question, delivered to the window that asked it.
   *
   * The one companion press that may raise the app, and only on a yes. Watch's
   * press is kept behind the user's work because that work is the session's
   * subject; by the time this is pressed the session is over, and the report is
   * a thing to read rather than a thing to avoid covering. A dismissal still
   * travels and still leaves the window where it is: the question lives in the
   * renderer that ran the retrospective, and the answer has to reach it either
   * way or it will ask again on its next push.
   */
  on("vellum:companion:answerWatchRetro", z.tuple([z.boolean()]), ([open]) => {
    if (!open) {
      dispatchWithoutRaising({ kind: "answerWatchRetro", open: false });
      return;
    }
    // The same shape `activate` takes, because it is the same request: bring
    // the app forward first, then tell it where to go. Dispatching before the
    // window is visible would navigate a page the user is not looking at.
    void ensureMainWindowVisible().then(() => {
      dispatchToMain({ kind: "answerWatchRetro", open: true });
    });
  });

  /**
   * The assistant's name and what the window holding it knows about the turn
   * and the sessions it is running.
   *
   * Published rather than fetched, because main has no conversation of its own
   * and no transport to fetch one with: see `companionContextSchema`.
   *
   * One channel for the whole snapshot rather than one per fact. They describe
   * the same assistant at the same moment, and a surface drawing a stale
   * `watching` beside a fresh name is exactly the skew independently-pushed
   * facts would produce.
   */
  on(
    "vellum:companion:setContext",
    z.tuple([companionContextSchema]),
    ([next]) => {
      context = next;
      syncWatchGlow();
      pushState();
    },
  );

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
  // The introduction's two presses. Main resolves them rather than taking a
  // beat from the renderer, so a press that arrives from a renderer showing a
  // beat main has already left is the no-op the guard makes it, not a jump
  // backwards.
  on(
    "vellum:companion:advanceIntro",
    z.tuple([z.enum(COMPANION_INTRO_ACTIONS)]),
    ([action]) => {
      if (intro === null) {
        return;
      }
      const next = introOnAdvance(intro, action);
      if (next === null) {
        finishIntro();
      } else {
        intro = next;
      }
      pushState();
    },
  );

  on("vellum:companion:contextMenu", z.tuple([]), () => {
    const win = getFloatingWindow(COMPANION_KIND);
    if (!win || win.isDestroyed()) {
      return;
    }
    const menu = Menu.buildFromTemplate(
      companionContextMenuTemplate(
        {
          avatar: readCompanionSize("avatar"),
          options: readCompanionSize("options"),
        },
        {
          open: openVellum,
          setSize: setCompanionSurfaceSize,
          hide: () => {
            setCompanionSurfaceVisible(false);
          },
        },
      ),
    );
    menu.popup({ window: win });
  });

  on("vellum:companion:activate", z.tuple([]), openVellum);

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
      // Taken whole, redundant or not. The mirror re-syncs on mount and the
      // session controller remounts across layout-level route changes while the
      // store persists, so a second start for a call already on screen is
      // expected traffic; every field it carries is current, so there is
      // nothing on the running call worth preserving against it.
      call = start;
      // The session is the answer the dial was waiting for. Cleared before the
      // push rather than through `setDialing`, so the surface sees one state
      // with the call on it and not a beat of neither.
      disarmDial();
      dialing = false;
      syncCallSurface();
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
    // With no session running this is the window asked for one saying no: a
    // first-run card to answer, an assistant with no voice, a request spent
    // some other way. Each has shown the user something else, so the dial ends
    // and the pill closes.
    if (call === null) {
      setDialing(false);
      return;
    }
    call = null;
    syncCallSurface();
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
      // The end control on a dial is the user changing their mind. The pill
      // closes here rather than waiting for the window asked to answer, and
      // the request is taken back by a command rather than by this control:
      // the control is heard only where a session is owned, and a dial can be
      // ended from a route where nothing owns one yet. The command lands in
      // the root layout, which is mounted wherever the request was parked.
      if (control.action === "endSession" && dialing) {
        setDialing(false);
        if (currentMainWindow() !== null) {
          dispatchToMain({ kind: "cancelVoiceStart" });
        }
      }
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

  /**
   * The window that publishes `watching` is gone, so stop claiming a screen is
   * being read.
   *
   * The session lives in the app's window: the socket and the microphone go
   * down with the renderer when it is destroyed, which is exactly why nothing
   * is left to report it. The renderer's own teardown cannot cover this, since
   * a destroyed document does not reliably run React cleanup, and this surface
   * outlives that window by design. Left alone the last context stands and the
   * pill goes on drawing a capture indicator over a machine nothing is
   * capturing, until some later window happens to publish over it.
   *
   * Fired on show, hide, and destroy alike, so the destroyed case is the one
   * where `currentMainWindow()` has already been cleared. Hiding the window
   * leaves the renderer alive and its session running, and must not clear
   * anything.
   *
   * The watch flag and the dictation, which are the two things in the context
   * that claim a microphone or a socket is open in that window. The name and
   * the tail are a record of what was said and this surface is still where it
   * is read, the same bargain `working` is given by `clearCompanionWorking`.
   */
  onMainWindowVisibilityChange(() => {
    if (currentMainWindow() !== null) {
      return;
    }
    // A dial is a claim on that window too: the request it carries is gone
    // with the renderer that parked it.
    const claiming =
      context.watching === true || context.dictating !== undefined || dialing;
    if (!claiming) {
      return;
    }
    disarmDial();
    dialing = false;
    syncCallSurface();
    context = {
      ...context,
      watching: false,
      dictating: undefined,
      dictationText: undefined,
    };
    syncWatchGlow();
    pushState();
  });

  // One avatar feeds every surface, so a change to the Dock icon is a change
  // here too. Repaint only: whether there is a surface to repaint is a question
  // about the assistant, not about its picture.
  onAvatarChange(pushState);

  // The assistant arriving or going away, which is what decides whether the
  // surface belongs on screen at all. The name is published after sign-in and
  // blanked on sign-out, so this is both edges.
  onNameChange(syncCompanionSurface);

  // Watch's flag arrives after launch, not before it: main reads it from
  // settings and the app's window is what puts it there, once it has signed in
  // and fetched an evaluation. A surface that is already open has to hear that
  // Watch became available, or stopped being, without waiting for something
  // else to move the state. It pushes rather than syncing, because whether the
  // surface is on screen is no longer this flag's business.
  onSettingChange("featureFlags", () => {
    pushState();
  });

  // The route loads lazily after the window is created, so a state pushed
  // before its subscription registers is dropped. It pulls this once mounted.
  handle("vellum:companion:getState", z.tuple([]), () => currentState());

  // Registered once here rather than per window: `refreshGrowth` no-ops
  // while no surface exists, and the surface can be closed and reopened from
  // the tray, which must not stack duplicate listeners. A display added,
  // removed or rearranged moves the edges the direction is measured against
  // without the window itself moving at all.
  screen.on("display-metrics-changed", refreshGrowth);
  screen.on("display-added", refreshGrowth);
  screen.on("display-removed", refreshGrowth);
};

export const openCompanionWindow = (): void => {
  if (getFloatingWindow(COMPANION_KIND) !== null) {
    return;
  }

  // A run is due the first time the surface actually reaches the screen, which
  // is later than launch and later than sign-in: it is the moment the thing
  // being introduced is there to be pointed at. Set before the window is
  // created so the state its route pulls on mount already carries the beat,
  // rather than the surface appearing plain and being annotated a frame later.
  if (!readCompanionIntroSeen()) {
    intro = COMPANION_INTRO_BEATS[0];
  }

  const win = createFloatingWindow({
    kind: COMPANION_KIND,
    route: COMPANION_ROUTE,
    width: geometry.canvasWidth,
    height: geometry.canvasHeight,
    // The canvas is a click-through sheet until the pointer reaches the pill.
    ignoreMouseEvents: { forward: true },
    position: defaultCanvasOrigin,
    browserWindow: {
      // The window draws no shadow of its own: `hasShadow` would outline the
      // invisible canvas rect rather than the pill inside it. Same reason the
      // dictation overlay turns it off.
      hasShadow: false,
      // **Unfocusable, like the dictation overlay.** `type: "panel"` already
      // makes the window non-activating, so clicking it never brings Vellum
      // forward; this goes further and stops it taking key status, because a
      // panel that becomes key on any press would hold the keyboard after a
      // press on Talk and swallow whatever the user typed next into the app
      // they are actually working in. Nothing on the surface takes a
      // keystroke, so there is no moment key status is owed to it.
      //
      // Should that change, lend it with `setFocusable` both ways and never
      // `blur()`: on macOS `blur` is `orderOut` then `orderBack`, which flashes
      // the window and brings it back without the mouse forwarding that makes
      // it hit-testable, leaving the avatar sitting there dead.
      focusable: false,
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
  // A home remembered for a window that no longer exists is one the next
  // window must not be sent to: it opens where every window opens.
  win.on("closed", () => {
    callHome = null;
  });
  // A surface shown mid-call is the call's from its first frame, and one
  // shown mid-session has the light beside it rather than under the cursor.
  syncCallSurface();
  syncWatchGlow();
};

const closeCompanionWindow = (): void => {
  getFloatingWindow(COMPANION_KIND)?.close();
};

/**
 * Show or hide the surface, persisting the choice so a hidden surface stays
 * hidden on the next launch.
 *
 * Hiding closes the window outright rather than making it invisible: the
 * canvas is a click-through mouse-event forwarder, and a hidden-but-alive
 * window would keep that machinery running for nothing. The live-voice
 * session state is unaffected either way, since main holds it (see `call`),
 * so a call running while the surface is hidden appears mid-call, clock
 * intact, when the surface is shown again.
 */
export const setCompanionSurfaceVisible = (visible: boolean): void => {
  writeCompanionHidden(!visible);
  if (visible) {
    // Through the same decision every other path uses, never straight to
    // `openCompanionWindow`. The tray item survives a sign-out, so a user who
    // had the surface hidden and then signed out could otherwise tick it and
    // get a blank disc floating over a signed-out app: the one state the
    // assistant gate exists to prevent, reached around the side.
    syncCompanionSurface();
    return;
  }
  // Putting the surface away mid-introduction is an answer to it. Recorded, so
  // bringing it back later does not start explaining it again to someone who
  // has already decided what they think.
  finishIntro();
  closeCompanionWindow();
};

/**
 * Draw the surface at a different size, keeping the avatar where it is.
 *
 * The canvas is derived from the size, so this is the one moment it resizes.
 * That is safe here in a way it would not be mid-gesture: a menu pick is a
 * deliberate, isolated event, where a canvas that grew during a drag would move
 * the window out from under the pointer.
 *
 * **The avatar's position is preserved, not the window's.** They are not the
 * same point and the difference is most of the canvas: keeping the origin would
 * slide the mascot by the change in its offset, which at the extremes is
 * hundreds of points, and the user would watch the thing they were trying to
 * enlarge walk off across the desktop. So the centre is read in the old
 * geometry, and the window placed in the new one around the same point.
 *
 * Both axes take this same path. Sizing the options alone leaves the creature
 * exactly as it was and still moves every edge around it: the pill's reach and
 * the card's height are stated in the options size, so the canvas has to be
 * built again for them.
 */
export const setCompanionSurfaceSize = (
  axis: CompanionSizeAxis,
  size: CompanionSize,
): void => {
  writeCompanionSize(axis, size);
  const next = geometryFor(
    readCompanionSize("avatar"),
    readCompanionSize("options"),
  );
  const win = getFloatingWindow(COMPANION_KIND);
  if (!win || win.isDestroyed()) {
    geometry = next;
    return;
  }
  const centre = avatarCentre(win);
  geometry = next;
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(centre.x),
    y: Math.round(centre.y),
  });
  const placed = placeCanvas(centre, workArea, geometry);
  cardGrowth = placed.cardGrowth;
  growth = growthFor(centre.x, workArea, geometry);
  // Bounds rather than size then position: two calls would put the window at
  // the new size in the old place for a frame, which on the largest step is a
  // visible jump of most of a canvas.
  win.setBounds({
    x: placed.origin.x,
    y: placed.origin.y,
    width: geometry.canvasWidth,
    height: geometry.canvasHeight,
  });
  pushState();
};

/**
 * Whether there is an assistant for the surface to be.
 *
 * The published identity, not the avatar. Main's avatar cache is empty for an
 * assistant whose avatar is simply unconfigured (`resolveAvatarRender` answers
 * `none` and the renderer publishes null for both the image and the traits), so
 * reading it here would keep the surface shut for exactly the users who never
 * picked one, and the surface has a fallback disc for that case. It is also
 * empty in the wrong direction: signing out clears the name and leaves the
 * cached avatar behind, which would leave a pill floating over the login
 * screen.
 *
 * The name is the identity signal, held in main by `identity.ts`, blank until
 * the renderer has fetched one and blanked again on sign-out and on an
 * assistant switch. An assistant the user is signed in to has one whatever its
 * avatar looks like.
 */
const hasAssistant = (): boolean => getAssistantName() !== null;

/**
 * Whether the surface belongs on screen, given an assistant to draw and the
 * user's own choice from the tray.
 *
 * The assistant is a floor and the tray preference is a veto, so both have to
 * say yes. Exported for its tests, as `callOnUpdate` is: it is the rule that
 * decides whether the most conspicuous window this app has appears at all.
 */
export const shouldShowCompanionSurface = (
  assistant: boolean,
  hidden: boolean,
): boolean => assistant && !hidden;

/**
 * Open or close the surface to match the two things that decide whether it
 * belongs on screen: whether there is an assistant to draw, and the user's own
 * choice from the tray.
 *
 * The single place that decision is made, called at launch and again whenever
 * either input changes. Two call sites reading the same pair of conditions is
 * how they come to disagree, and disagreeing here means either a floating
 * avatar nobody asked for or a missing one the user turned on.
 *
 * **Neither input ever writes the other.** Signing out has to leave the tray
 * preference exactly as the user left it, so that signing back in restores the
 * surface for someone who wanted it and leaves it hidden for someone who did
 * not.
 */
export const syncCompanionSurface = (): void => {
  if (shouldShowCompanionSurface(hasAssistant(), readCompanionHidden())) {
    openCompanionWindow();
    return;
  }
  closeCompanionWindow();
};
