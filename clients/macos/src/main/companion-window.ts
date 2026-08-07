import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import {
  companionContextSchema,
  voiceActivityContentSchema,
  voiceActivityControlSchema,
  voiceActivityStartSchema,
  type CompanionGrowth,
  type CompanionContext,
  type CompanionSurfaceState,
  type VellumCommand,
  type VoiceActivityState,
} from "@vellumai/ipc-contract";

import { getAvatarPng, getCharacter, onAvatarChange } from "./avatar";
import { createFloatingWindow, getFloatingWindow } from "./floating-window";
import { handle, on } from "./ipc";
import {
  current as currentMainWindow,
  dispatchToMain,
  ensureVisible as ensureMainWindowVisible,
} from "./main-window";
import { onSettingChange, readSetting } from "./settings";
import { readCompanionHidden, writeCompanionHidden } from "./window-state";

/**
 * The flag the whole surface is behind, evaluated for the signed-in user and
 * written into settings by the app's window (`useElectronFeatureFlagBridge`).
 *
 * Absent means off, which is the answer for every state that is not a positive
 * evaluation: a fresh install whose window has not synced yet, and an
 * environment where the flag was never provisioned. An avatar that appears
 * over everything the user is doing is the most conspicuous thing this app
 * ships, so the state of not knowing has to be the state of not showing it.
 */
const SURFACE_FLAG = "companion-surface";

export const isCompanionSurfaceEnabled = (): boolean =>
  readSetting("featureFlags")?.[SURFACE_FLAG] === true;

/**
 * Whether the surface belongs on screen, given the flag and the user's own
 * choice from the tray.
 *
 * The flag is a floor and the tray preference is a veto, so both have to say
 * yes. Exported for its tests, as `callOnStart` is: it is the rule that decides
 * whether the most conspicuous window this app has appears at all.
 */
export const shouldShowCompanionSurface = (
  enabled: boolean,
  hidden: boolean,
): boolean => enabled && !hidden;

/**
 * The companion surface (LUM-3086): the assistant's avatar floating from app
 * launch, expanding on hover into a pill with the voice and type-chat options,
 * and holding that expansion for as long as a call runs. It stays on screen
 * for the app's whole run unless the user hides it via the tray's "Show
 * Floating Companion" item, a choice that persists across launches
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

/**
 * The tallest the surface gets, which is the typing card.
 *
 * Every other state is a pill exactly {@link AVATAR_BOX} tall. The card stacks
 * the conversation on top of that row, in a viewport that scrolls once it is
 * full, so the card has a ceiling rather than growing with the exchange: the
 * renderer's `TURNS_MAX_HEIGHT` (220) and its padding, over the composer.
 * Rounded up from what that comes to, because the text is laid out in the
 * renderer and a canvas a few points short clips the top of the card off.
 *
 * Matched to `CompanionSurface`'s card in `companion-surface.tsx`, the way
 * {@link MAX_PILL_WIDTH} is matched to its widths.
 */
const MAX_CARD_HEIGHT = 290;

/**
 * How far the surface reaches above the avatar's centre.
 *
 * The card grows upward out of the composer row, which holds the line the pill
 * occupied, so the avatar stays exactly where it was when Type was pressed. It
 * has to: the surface is parked by the Dock, where a card growing downward
 * grows off the bottom of the screen.
 */
const MAX_RISE = MAX_CARD_HEIGHT - AVATAR_BOX / 2;

const CANVAS_WIDTH = MAX_REACH * 2 + CANVAS_PAD * 2;

/**
 * Sized for the tallest state rather than resized on the phase, the same
 * bargain the width makes: the avatar is pinned to the centre of this canvas,
 * so the height it can reach upward is height it also spends downward. A canvas
 * that grew with the card would move the window under the pointer mid-press and
 * put the expansion back on the main process, which is what the fixed canvas
 * exists to avoid.
 */
const CANVAS_HEIGHT = (MAX_RISE + CANVAS_PAD) * 2;

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
 * The assistant and the conversation's tail, as the window holding them last
 * published.
 *
 * Held here for the same reason the session is: the surface's renderer reloads,
 * and a card that came back empty would read as the exchange the user just had
 * on it having been thrown away.
 */
let context: CompanionContext = { assistantName: "", turns: [] };

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
  return {
    growth,
    character: character === null ? undefined : character,
    avatarBase64: png === null ? undefined : png.toString("base64"),
    call,
    assistantName: context.assistantName,
    turns: context.turns,
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
const dispatchWithoutRaising = (command: VellumCommand): void => {
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
   */
  on("vellum:companion:startVoice", z.tuple([]), () => {
    dispatchWithoutRaising({ kind: "startVoice" });
  });

  /**
   * Type, sent: the message goes to the same renderer Talk's press goes to, and
   * lands in the conversation that renderer has open.
   *
   * The surface holds no conversation and no transport, only the words. What
   * comes back is the reply, in the app or as a notification, the same as any
   * other message the user sends.
   */
  on(
    "vellum:companion:submit",
    z.tuple([z.string(), z.boolean()]),
    ([message, startsConversation]) => {
      dispatchWithoutRaising({
        kind: "companionSubmit",
        message,
        startsConversation,
      });
    },
  );

  /**
   * The assistant and the conversation's tail, from the window holding them.
   *
   * Published rather than fetched, because main has no conversation of its own
   * and no transport to fetch one with. The turns arrive already condensed to a
   * side and some text: see `companionContextSchema`.
   */
  on(
    "vellum:companion:setContext",
    z.tuple([companionContextSchema]),
    ([next]) => {
      context = next;
      pushState();
    },
  );

  /**
   * The composer, opened and closed: the window may hold the keyboard for
   * exactly that long.
   *
   * The counterpart to `setInteractive` above. The window is created
   * unfocusable so an ordinary press on the pill leaves the keyboard with
   * whatever app the user is working in, and this is what lends it out.
   *
   * **`setFocusable` both ways, and never `blur`.** `blur` is the only call
   * that makes this window resign key status outright, and on macOS it is
   * `orderOut` followed by `orderBack`: the surface is taken off screen and put
   * back at the bottom of its level. That reads exactly as it sounds, as a
   * flash, and the window comes back without the mouse forwarding that makes it
   * hit-testable, so the avatar is left sitting there dead. A surface that
   * breaks itself every time the user backs out of Type is far worse than the
   * one thing `setFocusable(false)` does not do, which is hand key status back
   * the instant the composer closes rather than the next time the user clicks
   * into the app they are working in.
   */
  on("vellum:companion:setComposing", z.tuple([z.boolean()]), ([composing]) => {
    const win = getFloatingWindow(COMPANION_KIND);
    if (!win || win.isDestroyed()) {
      return;
    }
    if (composing) {
      win.setFocusable(true);
      win.focus();
      return;
    }
    win.setFocusable(false);
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

  // The flag arrives after launch, not before it: main reads it from settings
  // and the app's window is what puts it there, once it has signed in and
  // fetched an evaluation. So the surface cannot be decided once at startup.
  // This is what opens it when the answer finally lands, and closes it if the
  // answer changes.
  onSettingChange("featureFlags", syncCompanionSurface);

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
      // **Unfocusable at rest, like the dictation overlay, but only at rest.**
      // `type: "panel"` already makes the window non-activating, so clicking it
      // never brings Vellum forward; this goes further and stops it taking key
      // status, because a panel that becomes key on any press would hold the
      // keyboard after a press on Talk and swallow whatever the user typed next
      // into the app they are actually working in. The surface does host a text
      // field, and a window that cannot become key cannot receive a keystroke,
      // so key status is granted for exactly as long as that field is open
      // (`setComposing`), the way mouse events are granted for exactly as long
      // as the pointer is on the pill.
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
    openCompanionWindow();
  } else {
    closeCompanionWindow();
  }
};

/**
 * Open or close the surface to match the two things that decide whether it
 * belongs on screen: the flag, and the user's own choice from the tray.
 *
 * The single place that decision is made, called at launch and again whenever
 * the flags in settings change. Two call sites reading the same pair of
 * conditions is how they come to disagree, and disagreeing here means either a
 * floating avatar nobody was meant to have or a missing one the user turned on.
 *
 * **The flag never writes the tray preference.** Losing the flag has to leave
 * the user's choice exactly as they left it, so that being targeted again
 * restores the surface for someone who wanted it and leaves it hidden for
 * someone who did not.
 */
export const syncCompanionSurface = (): void => {
  if (shouldShowCompanionSurface(isCompanionSurfaceEnabled(), readCompanionHidden())) {
    openCompanionWindow();
    return;
  }
  closeCompanionWindow();
};
