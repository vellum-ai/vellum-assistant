import {
  AudioLines,
  Check,
  Eye,
  EyeOff,
  Mic,
  MicOff,
  ScrollText,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  Ref,
} from "react";

import type { CompanionDictating } from "@vellumai/ipc-contract";
import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_BASE_AVATAR_IMAGE,
} from "@vellumai/ipc-contract";
import type {
  CompanionCharacter,
  CompanionWatchRetro,
  VoiceActivityControlAction,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { CompanionPeek } from "@/components/companion-peek";
import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The macOS companion surface (LUM-3086): the assistant's avatar floating from
 * app launch, with a pill carrying the ways to reach it unfurling beside it,
 * and unfurling the same way while a call runs.
 *
 * **Two elements, and the mascot is the fixed point.** The creature and the
 * pill are siblings with a gap between them rather than one box holding the
 * other. The avatar holds one point in the canvas in every state, which is the
 * point the host positions this window around, so the surface reads as one
 * object changing shape rather than a series of different objects and the eye
 * and the cursor always have the same target to aim at. The pill hangs off it:
 * its avatar-facing edge sits the avatar's half box plus the gap from that
 * point, and its bottom edge sits on the avatar's bottom, so the two keep one
 * baseline whatever the pill is carrying. Only the pill's `width` animates.
 *
 * **Two sizes, and the creature carries the difference.** The host publishes a
 * box for the avatar and a box for the pill, and the page around this scales
 * the whole canvas by the second, so every length below is stated once at the
 * size the layout is authored at. The creature is scaled again inside that by
 * the ratio between the two boxes, and the handful of distances measured from
 * its edge (the gap, the near edge, its own half box) are worked out from the
 * contract's helpers and divided back into these units.
 *
 * **Growth needs clearance on the side it runs into**: the gap, and then a pill
 * as wide as `COMPANION_BASE_MAX_PILL_WIDTH`, which is the host's ceiling. A
 * circle parked against the right edge does not have it, and unclamped
 * the pill would run straight off the display with the controls the user was
 * reaching for. So the surface flips and grows the other way instead, the way a
 * menu does, through {@link growth}.
 *
 * **Presentational only.** Phase comes from the caller, so this renders
 * identically in Storybook and in the Electron panel. Hover is a phase rather
 * than internal state because in the real window the pointer is tracked by the
 * main process through `setIgnoreMouseEvents(true, { forward: true })`, which
 * delivers mouse-move without capturing clicks meant for whatever is behind.
 *
 * **Solid, not glass, and that is forced.** The only real blur available is the
 * window's native vibrancy material, and a window's material fills the window.
 * This one is a canvas many times the size of the pill, so asking for glass
 * frosts a rectangle across the desktop. Sizing the window to the pill would
 * buy real glass at the cost of resizing it on every expansion, which is the
 * thing the fixed canvas exists to avoid. `backdrop-filter` is no help either:
 * it samples what is behind it within the page, and the desktop is not in the
 * page.
 *
 * So the pill paints its own near-opaque background, as the dictation overlay
 * does. That is also what makes it readable over a pale desktop and a busy one
 * alike.
 *
 * Open, and reproducible from the stories:
 *
 * 1. **Nothing marks a live call while resting.** The circle looks identical
 *    whether or not the microphone is open, which is the state this surface
 *    exists to make visible.
 */

export type CompanionSurfacePhase =
  | "resting"
  | "hover"
  /**
   * Watching: the pill held open by a session reading the screen.
   *
   * Open regardless of the pointer, the way `call` is, and for a sharper
   * reason. A screen reader that hides itself when the pointer leaves is one
   * the user cannot see, and a capture nobody can see is one nobody can stop.
   *
   * It ranks below `call` and above `hover`: a live call is something the user
   * is in the middle of. Being outranked costs the session nothing, because
   * this phase is only what
   * the pill is showing. Whether the screen is being read is
   * {@link CompanionSurfaceProps.watching}, and that is what the indicator
   * reads.
   */
  | "watching"
  /**
   * Summary: the pill held open by what a finished watch session left behind.
   *
   * A session ends twice, and this is the second ending. The socket closes when
   * the user presses stop, and the account of what they narrated is written
   * afterwards by a turn that runs for the better part of a minute. Collapsing
   * to rest across that gap reads as the recording having been discarded, and
   * the report would then land in a thread nobody was shown.
   *
   * So the pill stays open, first saying the summary is being written and then
   * asking whether to open it. It ranks below `watching` because a session
   * still recording outranks the leftovers of one that is not, and above
   * `hover` because it is a question waiting on an answer rather than a hint.
   */
  | "summary"
  /**
   * Dictating: the pill held open by a microphone the user is holding a key
   * for, somewhere else entirely.
   *
   * Open regardless of the pointer, for the reason `watching` is: this surface
   * is the only thing on screen while the words are going into another app, so
   * it is the only thing that can say the microphone is open, and one that hid
   * itself would be a live microphone nobody can see.
   *
   * It outranks `watching` because the user is in the middle of it and it lasts
   * seconds rather than minutes, and it is outranked by `call` for the reason
   * everything is: that is something they are already inside.
   */
  | "dictating"
  /**
   * Call: the pill held open by a live-voice session, or by the press that
   * asked for one.
   *
   * With a session it is the handlebar of the call: what the session is
   * doing, and the controls that act on it. Without one it is the dial, the
   * beat between Talk and the session's first word, drawn so the press is
   * seen to have done something while the session opens in a window the user
   * cannot see.
   */
  | "call";

/**
 * Which way the pill grows out of the avatar, which holds its place.
 *
 * `right` is the shape this is designed around; `left` is what it degrades to
 * when the right edge of the display is too close for the pill's widest state.
 * The main process decides: it owns the window's position and is the only side
 * that knows which display it is on.
 */
export type CompanionSurfaceGrowth = "right" | "left";

/**
 * Which side of the avatar the canvas reserves the card's height on, which is
 * where the introduction's card is drawn and which edge of the canvas the
 * avatar is anchored to.
 *
 * `up` is where the surface normally opens: it lives by the Dock, where a card
 * growing downward would grow off the bottom of the screen. `down` is what it
 * flips to near the top of a display, and the reason it has to exist at all is
 * the host's, not the layout's: macOS refuses to place a window frame above
 * the top of the work area, so an avatar that always reserved the card's height
 * above itself could never be dragged into the top of the screen at all
 * (JARVIS-1548). Main decides, for the same reason it decides the other one.
 */
export type CompanionSurfaceCardGrowth = "up" | "down";

/** Fallback accent, used until the assistant's own avatar colour is known. */
const DEFAULT_ACCENT = "#5eead4";

/**
 * The phases that are the assistant's turn rather than the user's.
 *
 * What the mascot expresses is whose turn it is, which is the distinction a
 * glance actually needs: the creature is either waiting on you or working. The
 * finer phase is in the words beside it, where the reading is deliberate.
 *
 * `connecting` and `ending` are neither turn, and read better as the ordinary
 * idle creature than as one straining.
 */
const ASSISTANT_TURN_PHASES = new Set(["transcribing", "thinking", "speaking"]);

/**
 * The colour a watch session lights the ring in.
 *
 * Fixed rather than the assistant's own accent, because the ring in the accent
 * already means "a turn is running" and a screen being read is a different fact
 * about the machine. Amber is the tone the host burns for a live capture, so
 * the surface agrees with the menu bar above it.
 */
const WATCHING_RING_ACCENT = "#ff9f45";

/**
 * The avatar artwork inside that box, which is inset by {@link INNER_GAP} on
 * every side. Both the still and the composed creature draw at this size, so
 * nothing moves when one replaces the other.
 *
 * From the contract because the pill lines up with the creature's visible
 * bottom: `companionBaselineFor` answers half of this, and the two processes
 * cannot be left holding different readings of where the creature stops.
 */
const AVATAR_IMAGE = COMPANION_BASE_AVATAR_IMAGE;

/**
 * The capsule the creature collapses into at rest.
 *
 * At rest this surface is a marker rather than a mascot. It sits on the desktop
 * all day over whatever the user is actually working in, and a character
 * standing there is a character in the way; a thin capsule says the assistant
 * is here and reachable and asks for nothing. The creature comes back the
 * moment the pointer arrives, which is the only time anyone is looking at it.
 *
 * As wide as the artwork it stands in for ({@link AVATAR_IMAGE}), so the
 * collapse reads as the creature tucking into its own width rather than as a
 * differently sized object taking its place. The height is the one authored
 * number here: thin enough to read as a marker, tall enough to see against a
 * busy desktop and to carry the working ring around.
 *
 * **The box it is drawn in does not shrink with it.** That box is the drag
 * handle, the point the host positions the window around, and the rect the
 * pointer is hit-tested against, so shrinking it would move the anchor the host
 * measures every drag and clamp against, and would make the surface hardest to
 * hit exactly when it is smallest. What changes is the shape drawn inside it.
 *
 * **Nor does the capsule grow with the sizes.** It is drawn at these numbers on
 * every setting, countering the scale the avatar's node carries (see
 * `restingScale` in {@link Avatar}). Sizing the creature is a statement about
 * the creature: someone who wants a big mascot when they look at it has not
 * asked for a big lozenge sitting over their work all day, and the marker is
 * the one part of this surface nobody chose to be looking at. Countering the
 * transform rather than the lengths is what keeps the border, the radius and
 * the ring identical at every setting instead of thickening with the scale.
 */
const RESTING_HEIGHT = 10;

/**
 * The capsule's box, which is exactly the accent the user sees: no rim.
 *
 * It wore a dark hairline for a while, to put an edge between the working ring
 * and a capsule painted the ring's own colour. It went because a creature
 * peeking out from behind a bordered pill reads as peeking out of a slot in a
 * device, and the pill is meant to be the creature's own colour and nothing
 * else. The ring still carries a turn at rest: its bright arc orbits and its
 * light falls on the desktop, and neither needs a dark line to be seen.
 *
 * One statement of it, because two things are sized from it and they must not
 * drift. The capsule is drawn at it, and the box the working ring rides matches
 * it at rest so the ring hugs the shape rather than the air around it.
 */
const RESTING_BOX = {
  width: AVATAR_IMAGE,
  height: RESTING_HEIGHT,
};

/**
 * The clearance every round thing inside the pill keeps from its edge.
 *
 * One number, because the geometry only works at one value. Nested rounded
 * shapes read as concentric when the inner radius equals the outer radius minus
 * the gap between them: the pill is 44pt tall so its radius is 22, and the
 * controls are 28pt tall so theirs is 14, which leaves exactly 8. That is
 * already the vertical gap, and it is already the avatar image's inset in its
 * own 44pt box, so the trailing control wants the same 8 at the right and every
 * curve stays parallel.
 *
 * Anything else crowds: at 4 the corners converge, and at 0 a control's hover
 * background runs flush into the pill's border and its corner gets clipped,
 * which reads as the surface being cut off.
 */
export const INNER_GAP = 8;

/**
 * How wide the running dictation's words are allowed to draw.
 *
 * Stated rather than measured, unlike every other body on this surface. Those
 * are rows of controls with a natural width; a sentence has none, and one
 * allowed to ask for what it wants would run past the canvas main sized for
 * the pill. What does not fit is clipped from the front, so the line stays
 * full of the most recent words.
 *
 * Sized so the row it sits in lands inside
 * {@link COMPANION_BASE_MAX_PILL_WIDTH}: the icon and its gap take 24, and the
 * row's own clearance takes {@link INNER_GAP} at either end.
 */
const TRANSCRIPT_WIDTH = 244;

/**
 * Body widths to use until the content has been measured.
 *
 * The body alone, since the avatar is a sibling of the pill rather than
 * something inside it: the pill is as wide as its content, plus an
 * {@link INNER_GAP} at either end, measured at runtime because a fixed width is
 * only ever right by accident. A pill wider than its body leaves `flex-1` to
 * pile the difference up after the last control as dead space.
 *
 * Measuring is also what makes the surface survive its own roadmap. Once
 * plugins contribute actions (LUM-3097) no hardcoded number can be correct, and
 * these become nothing but the value for the first frame.
 *
 * **Every measured body plus an {@link INNER_GAP} at either end stays at or
 * under {@link COMPANION_BASE_MAX_PILL_WIDTH}**, which is the whole width a
 * pill actually draws. The window is a fixed canvas sized once for the widest
 * state the surface has, so the ceiling is the host's rather than this file's:
 * a state that wanted more would be clipped by the window, and buying the room
 * back means resizing the canvas, which is the thing a fixed canvas exists to
 * avoid.
 *
 * The one phase that never reaches this is absent from it: `resting` has no
 * pill to measure.
 */
export const FALLBACK_WIDTHS: Record<
  Exclude<CompanionSurfacePhase, "resting">,
  number
> = {
  // Two icon-only controls, which is the row as it is first drawn: the labels
  // are revealed one at a time under the pointer, and on the first frame there
  // is no pointer on any of them yet.
  hover: 84,
  // The same row of controls hover draws, since the session is run from it
  // rather than from a row of its own, plus the one word the running session
  // pins open on the control holding it.
  watching: 123,
  // Two labelled controls, both drawn: this row is a question waiting on an
  // answer rather than a set of ways in, so its words are not the pointer's to
  // reveal. That is what makes it wider than the idle row it stands in for.
  summary: 220,
  // The transcript box beside the icon and the row's own clearance. The box
  // has a stated width whatever is in it, so this is the state's actual width
  // rather than a guess at one.
  dictating: TRANSCRIPT_WIDTH + 32,
  // The line and the four controls of the handlebar, with Teach held down and
  // so spelling its name out, which is the widest a call draws.
  call: 332,
};

export interface CompanionSurfaceProps {
  phase: CompanionSurfacePhase;
  /**
   * Who the dial is calling. Read only while the phase is `call` and there is
   * no {@link call} yet; a session names its own assistant. Empty is a dial
   * with no name to say.
   */
  assistantName?: string;
  /** The assistant's avatar colour. Fills shapes; never carries text. */
  accentHex?: string;
  /**
   * The assistant's avatar. Any image source: the Electron payload carries it
   * as base64, which the caller turns into a data URL. Falls back to a disc in
   * the accent colour while it is still resolving.
   *
   * Only used when there is no {@link character} to compose, since a still
   * cannot blink.
   */
  avatarSrc?: string;
  /**
   * The traits to compose the live creature from.
   *
   * **This is the surface's status channel.** The mascot is the one thing on
   * the pill present in every state, so it is what carries how the assistant
   * *is*: it blinks and breathes at rest, and holds a focused, morphing pose
   * while the turn is the assistant's. That is also what frees the mic and
   * speaker glyphs to mean nothing but their controls.
   *
   * Absent for an assistant whose avatar is a custom uploaded image, which
   * falls back to {@link avatarSrc} and does not animate.
   */
  character?: CompanionCharacter;
  /**
   * Whether the pointer is on the surface, which the creature answers by
   * widening its eyes.
   *
   * Passed rather than derived from `phase`, because a call and a watch session
   * both hold the pill open regardless of the pointer and the mascot should
   * still notice a hand arriving over it either way.
   */
  hovered?: boolean;
  /** Which way the pill grows. See {@link CompanionSurfaceGrowth}. */
  growth?: CompanionSurfaceGrowth;
  /**
   * The creature's box in points, which is the avatar's whole scale.
   *
   * Its own size rather than the surface's, because the two are chosen
   * separately: a mascot big enough to read from across the room is not a pill
   * that wide. Defaulted to the size the layout is authored at, which is what
   * Storybook draws and what the host publishes for a surface nobody has
   * resized.
   */
  avatarBox?: number;
  /**
   * The pill's box in points, which is the scale of everything that is not the
   * creature.
   *
   * The surface scales its own outermost box by this, so what it is for beyond
   * that is converting back: a distance the host and this side have to agree on
   * is worked out in points from the contract's helpers and divided by this
   * scale on its way into a style, so both ends are the same expression.
   */
  optionsBox?: number;
  /**
   * Which way the card grows, and with it which edge of the canvas the avatar
   * is anchored to. See {@link CompanionSurfaceCardGrowth}.
   */
  cardGrowth?: CompanionSurfaceCardGrowth;
  /**
   * The pill's own element.
   *
   * The Electron host needs to hit-test the pointer against the pill rather
   * than trust `mouseenter`: its window is click-through, and what a
   * click-through window delivers is forwarded mouse-move. Only this component
   * knows where the pill ended up, so it hands the element out instead of
   * restating the geometry at the call site.
   */
  rootRef?: Ref<HTMLDivElement>;
  /**
   * The avatar's own element.
   *
   * Handed out for the reason {@link CompanionSurfaceProps.rootRef} is, and
   * separately from it: the avatar and the pill are siblings with a gap between
   * them, so the host hit-tests a union of their rects rather than one box. A
   * box drawn around both would claim the empty canvas above and below the gap
   * and swallow the presses landing there.
   */
  avatarRef?: Ref<HTMLDivElement>;
  /**
   * Begin a drag. Everything drawn that is not a control is a handle, so this
   * is wired to the avatar and to the pill, and the controls stop the press
   * from reaching it. The gap between the two is not a handle: there is nothing
   * drawn in it to grab.
   */
  onSurfacePointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /**
   * Open the surface's own menu, which a right-click on the avatar or the pill
   * asks for.
   *
   * On both rather than on the avatar alone: a user reaching for "make this go
   * away" should not have to find the mascot beside the pill first.
   */
  onSurfaceContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /**
   * Draw a control as though the pointer were on it.
   *
   * Real hover is CSS and needs no help. This is for playback with no pointer
   * in the room, where a hand reaching for Talk is the whole point of the
   * frame.
   */
  spotlight?: "talk";
  /**
   * Start a live-voice session. Absent leaves Talk inert, which is what
   * Storybook wants: there is no session to start there.
   */
  onTalk?: () => void;
  /**
   * Start or stop the session that reads the screen, which is what Watch does.
   *
   * One press for both edges, the way the contract's `toggleWatch` is: the
   * surface draws a single control, and the side holding the session is the
   * only one that knows which edge a press is.
   */
  onWatch?: () => void;
  /**
   * Press the avatar: go back to Vellum, on the conversation the surface
   * belongs to.
   *
   * Wired to the avatar rather than the pill because the pill's body is
   * controls, and to a press that did not turn into a drag: the whole surface
   * is a drag handle, and the avatar is the part of it a user is most likely to
   * grab. The caller owns that distinction, since it is the side holding the
   * pointer.
   */
  onAvatarClick?: () => void;
  /**
   * Whether a turn is in flight, from the window that owns the conversation.
   *
   * Drawn as the working ring, and as the creature's own working pose. It is
   * the surface's answer to "is it doing anything", which otherwise could only
   * be had by reading the card, and only when the card was open.
   *
   * A running call reports its own turns through {@link call}, so this is what
   * covers every turn that is not one: anything the user set going in the app
   * before turning back to their own work.
   */
  working?: boolean;
  /**
   * Whether a session reading the screen is running.
   *
   * Its own input rather than `phase === "watching"`, and this is the one place
   * on the surface where that separation is not a matter of taste. The phase
   * says what the pill is showing; this says whether the screen is being read,
   * and they are different questions. A phase is outranked by a live call, so
   * an indicator drawn from one would go dark the moment the user took a call,
   * which is the same capture the user cannot see with a different trigger.
   * The ring belongs to the session,
   * not to whatever the surface happens to be drawing over it.
   *
   * Absence is not a session, the way `CompanionSurfaceState.watching` has it:
   * every state that is not a positive answer has to read as nothing running,
   * because the alternative is a consent signal over a machine nobody is
   * capturing.
   */
  watching?: boolean;
  /**
   * Where the summary of the last finished session has got to, or absent when
   * there is none to draw.
   *
   * `pending` while the turn that writes it runs, `ready` once there is a
   * report to open. Its own input rather than something derived from `phase`
   * for the reason {@link CompanionSurfaceProps.watching} is: the phase is
   * outranked by a call, and a question the user has been asked must not
   * silently lose its answer because they picked up the phone.
   */
  watchRetro?: CompanionWatchRetro;
  /**
   * Answer that question: open the summary now, or not.
   *
   * One handler for both, because they are one decision. The surface holds
   * neither the conversation nor the router, so both answers leave it; what
   * comes back is {@link CompanionSurfaceProps.watchRetro} going absent.
   */
  onWatchRetro?: (open: boolean) => void;

  /**
   * How many times the running session has read the screen.
   *
   * Drawn as one brief flare of the ring per read, which is the difference
   * between a surface that says a session is on and one that shows the thing
   * the session actually does. A session is minutes long and its reads are
   * three or four a minute, so the state and the events inside it are separate
   * facts and each gets its own treatment: the lit ring for the session, a
   * flare for each capture.
   *
   * **A number that only goes up, and only when a capture landed.** The
   * runtime counts a read that came back and was kept, and everything between
   * here and there passes the count along without inventing steps in it, so a
   * flare drawn from a step is a capture that happened. Nothing on this surface
   * may fill the gaps in: the cadence follows what the user is doing, and a
   * pulse on a local timer would claim the machine read a screen it did not.
   *
   * Zero is a session that has not captured yet, which draws the ring and no
   * flare.
   *
   * **A value, not an event.** This surface can meet a session at any point in
   * it, and on macOS it routinely does: the renderer is recreated on a reload
   * and the main process hands the new one the state it is holding, so a count
   * of forty can arrive standing for a read that happened a minute ago. Only a
   * step that lands inside a session this surface was already watching is a
   * capture happening now, so a count that arrives with the session is a
   * baseline and draws nothing.
   */
  captureCount?: number;

  /**
   * Whether Watch is offered at all, which is the feature flag rather than any
   * fact about a session.
   *
   * Separate from {@link CompanionSurfaceProps.watching} because the two answer
   * questions that can disagree in the one direction that matters: a session
   * left running when the flag is turned off still has to draw its indicator
   * and its stop control, since a capture the user cannot see or end is the
   * failure this surface exists to prevent. So this hides the way in and
   * nothing else.
   *
   * Absence is not permission. Defaulted off rather than on for the reason
   * `CompanionSurfaceState.watchEnabled` is read that way: every caller with no
   * evaluation in hand is a caller that does not know, and a control that reads
   * the user's screen is not offered on a guess.
   */
  watchEnabled?: boolean;
  /**
   * The running session, when `phase` is `call`.
   *
   * Absent renders the call state from fixed sample values, which is what the
   * static stories want: there is no session behind them.
   */
  call?: VoiceActivityState;
  /**
   * Act on the running session: mute, unmute, end, or answer the confirmation
   * it is waiting on.
   *
   * **Each action is the absolute state the button's own label promised, never
   * a toggle.** The surface can be drawing content a beat behind the session,
   * so a toggle resolved against live state would be self-consistent and still
   * wrong for the user: a button reading "Mute assistant" over an already-muted
   * session would unmute it. Sending what the button said makes a stale press a
   * no-op the next push corrects.
   */
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
  /**
   * The introduction's card, drawn beside the surface while a run is on.
   *
   * Passed in as a node rather than built here, so this component keeps knowing
   * nothing about the run: it is the surface, and the introduction is something
   * placed next to the surface. The host owns the beat, the copy and the
   * presses; all this owns is that the card is a sibling of the pill rather
   * than a child of it, which is what keeps it out of the width that animates.
   */
  intro?: ReactNode;
  /**
   * What a keyboard dictation has got to, when one is running. See
   * {@link CompanionDictating}.
   */
  dictating?: CompanionDictating;
  /**
   * The words recognised so far in that dictation. See
   * {@link CompanionContext.dictationText}.
   */
  dictationText?: string;
}

/**
 * How many captures this surface has watched arrive, which is not the same as
 * how many the session has taken.
 *
 * {@link CompanionSurfaceProps.captureCount} is a running total that outlives
 * any one surface reading it. The macOS renderer is recreated on every reload
 * and the main process replays its retained state into the new one, so a
 * surface routinely meets a session already forty reads in. A flare drawn off
 * the value would present the last of those as a capture happening now, which
 * is the one thing this indicator must never do: it is worth something only
 * because a flare means the screen was read at that moment.
 *
 * So a step counts only when it lands inside a session this surface was
 * already watching. That covers both ways a total arrives without a capture
 * behind it: the first render, whatever the count is by then, and the jump
 * from nothing to a session already in progress, which is what a reload looks
 * like from here. What is left is a count moving under a session that was
 * running a moment ago, which is a read that just happened.
 *
 * The result is a key rather than a flag, so each step remounts the element and
 * replays a one-shot animation instead of a single node playing once for the
 * first capture and sitting still through the rest.
 *
 * Zero is nothing observed yet, which draws no flare. It returns to zero when
 * the session ends, so the next session starts from a baseline of its own
 * rather than the last flare replaying the moment the ring comes back on.
 */
function useObservedCaptures(captureCount: number, watching: boolean): number {
  const seen = useRef({ captureCount, watching });
  const [observed, setObserved] = useState(0);

  useEffect(() => {
    const previous = seen.current;
    seen.current = { captureCount, watching };
    if (!watching) {
      setObserved(0);
      return;
    }
    if (previous.watching && captureCount > previous.captureCount) {
      setObserved((count) => count + 1);
    }
  }, [captureCount, watching]);

  return observed;
}

export function CompanionSurface({
  phase,
  assistantName = "",
  accentHex = DEFAULT_ACCENT,
  avatarSrc,
  character,
  hovered = false,
  growth = "right",
  avatarBox = COMPANION_BASE_AVATAR_BOX,
  optionsBox = COMPANION_BASE_AVATAR_BOX,
  cardGrowth = "up",
  rootRef,
  avatarRef,
  onSurfacePointerDown,
  onSurfaceContextMenu,
  spotlight,
  onTalk,
  onWatch,
  onAvatarClick,
  working = false,
  watching = false,
  watchRetro,
  onWatchRetro,
  captureCount = 0,
  watchEnabled = false,
  dictating,
  dictationText = "",
  call,
  onControl,
  intro,
}: CompanionSurfaceProps) {
  const expanded = phase !== "resting";
  /**
   * Whether the summary of a finished session is still being written.
   *
   * Drawn as the session's own ring rather than the assistant's, because it is
   * the same session finishing rather than an unrelated turn: the user pressed
   * stop and the light is still on for what they narrated. Reads off the input
   * rather than the phase, since a call outranks the phase and the work goes on
   * regardless.
   */
  const summarizing = watchRetro === "pending";

  /**
   * Whether the assistant is working, from whichever side is in a position to
   * know.
   *
   * A call reports its own phase and everything else is reported by the window
   * that owns the turn, but the surface draws one thing either way. Two
   * treatments for one fact would make a spoken reply and a typed one look like
   * different states of the assistant, when the only difference is which way
   * the user happened to ask.
   */
  const assistantWorking =
    working || (call !== undefined && ASSISTANT_TURN_PHASES.has(call.phase));
  const observedCaptures = useObservedCaptures(captureCount, watching);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);

  // The body is measured while it is still clipped, so the pill knows how wide
  // to grow before it starts growing. `scrollWidth` reports the content's own
  // width regardless of how little the collapsed pill is giving it.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    const measure = () => {
      setContentWidth(element.scrollWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [phase]);

  // The body and the clearance at either end of it, and nothing else: the
  // avatar has a box of its own beside the pill rather than a column inside it.
  const width = !expanded
    ? 0
    : (contentWidth ?? FALLBACK_WIDTHS[phase]) + 2 * INNER_GAP;

  // The distances everything below is placed by, in points, and the one
  // conversion into the units this layout is stated in. Shared with
  // `CompanionIntro`, whose card hangs off the same creature.
  const { scale, avatarRel, avatarHalf, baseline, gap, lineAt, edgeAt } =
    companionLayoutFor(avatarBox, optionsBox);

  // **The avatar never moves.** It holds one spot in the canvas, which is the
  // spot the host positions this window around, and the pill hangs off one side
  // of it across the gap. Growing from the pill's centre instead would slide
  // the mascot to a different x-position in every state, so the surface would
  // read as a series of different objects rather than one object changing
  // shape, and the user's eye and cursor would have no fixed target to aim at.
  //
  // So each direction pins the pill's avatar-facing edge that far out from the
  // centre and lets the body run the rest of the way: the pill is what moves
  // when `growth` flips, and the creature the host measures every drag, clamp
  // and direction check against is not.
  const placement = edgeAt(growth, avatarHalf + gap);

  /**
   * Whether the introduction's card is drawn beside the surface.
   *
   * `null` is what the host passes when there is no beat to draw and
   * `undefined` is what a caller that never mentions it leaves behind, and both
   * mean the same thing. Named rather than tested inline, because the one thing
   * that reads it is deciding whether the creature is on screen at all.
   */
  const introDrawn = intro !== null && intro !== undefined;

  const style: CSSProperties = {
    width,
    ...placement,
    // **On the creature's visible bottom.** The pill's bottom edge sits on the
    // bottom of the artwork, so the two keep one baseline whatever the pill is
    // carrying. The line is the artwork, not the avatar's *box*, which runs an
    // `INNER_GAP` further down to hold the bob's slack. Which edge
    // of the canvas that line is measured from is the host's call (see
    // `CompanionSurfaceCardGrowth`).
    top: lineAt(cardGrowth, baseline),
    transform: "translateY(-100%)",
    // Settles rather than overshoots. A surface on screen all day should not
    // bounce every time the pointer crosses it.
    transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
  };

  /**
   * The creature's edge, lit for something running and flared for each capture.
   *
   * **On the avatar in every phase.** The creature is the one thing drawn in
   * all of them and it holds one spot in the canvas, so the light stays where
   * the eye already looks for this surface's state, and a working creature
   * reads perfectly well beside an open pill. Handing it to the pill while
   * expanded would move it to a different parent every time the pointer
   * crossed, which unmounts the one-shot flare below and replays it for a
   * capture that never happened.
   */
  const edge = (
    <>
      {/* Something running, as a light travelling around the edge. Drawn over
          the creature so it reads as the creature's own border, and outside
          the creature's box by a hair so it never crowds the artwork.

          A turn burns it in the assistant's colour, a watch session in amber,
          and the session's ring is drawn in every phase rather than only the
          one named after it. The session also takes the colour when both are
          true: the creature already carries the turn in its own pose, and a
          capture running with nothing drawn over it is the worse of the two
          failures. */}
      {(assistantWorking || watching || summarizing) && (
        <span
          className="companion-working-ring pointer-events-none absolute -inset-0.5 rounded-full"
          style={{
            ["--companion-ring-accent" as string]: watching
              ? WATCHING_RING_ACCENT
              : accentHex,
          }}
          aria-hidden
        />
      )}
      {/* One capture, as a single breath of light around the same edge.

          The ring says a session is running, which is a state; this says the
          screen was read just now, which is an event, and the two need
          different treatments or the second is invisible inside the first. The
          same edge rather than a mark of its own, because the edge is already
          where the user looks for this surface's state and a capture is that
          state doing something.

          Keyed by the captures this surface has watched arrive, so each one
          remounts the element and replays a one-shot animation. That is the
          whole mechanism: a step is a read the runtime took and kept, and
          there is no other way for this to fire. It cannot pulse in a gap, it
          cannot pulse for a read that failed, timed out, or was cut off by the
          session ending, because none of those advance the count, and it
          cannot pulse for the count a reload handed it, because a first value
          is a baseline rather than a step. */}
      {watching && observedCaptures > 0 && (
        <span
          key={observedCaptures}
          className="companion-capture-pulse pointer-events-none absolute -inset-0.5 rounded-full"
          style={{
            ["--companion-ring-accent" as string]: WATCHING_RING_ACCENT,
          }}
          aria-hidden
        />
      )}
    </>
  );

  return (
    // The box the whole surface is drawn in: the canvas divided by the options
    // scale, blown back up about its top-left corner, so every authored length
    // inside resolves in base units and the host never holds a second set of
    // dimensions.
    //
    // The pill, the creature and the introduction's card are siblings inside it,
    // never nested: a card inside the pill would sit in the box whose width
    // animates from state to state and be clipped by the pill's own rounding,
    // and beside it they all hang off the same fixed avatar position.
    <div
      className="absolute top-0 left-0 origin-top-left"
      style={{
        width: `${100 / scale}%`,
        height: `${100 / scale}%`,
        transform: `scale(${scale})`,
      }}
    >
      {/* The pill is a drag handle, as the avatar is. Controls opt out by
        stopping the press, so everything on it that is not a button can be
        grabbed. */}
      <div
        // One row in a box whose width animates, so the row is pinned to the
        // pill's avatar-facing edge. `growth: "left"` anchors the pill by its
        // right, and a row left-aligned in a box narrower than itself spills
        // past that edge, across the gap and over the creature, every time the
        // width lags the content: through the unfurl and instantly on each
        // label reveal.
        className={`absolute flex h-11 cursor-grab items-center rounded-full transition-[width] duration-300 select-none will-change-[width] active:cursor-grabbing ${growth === "left" ? "justify-end" : ""}`}
        style={style}
        onPointerDown={onSurfacePointerDown}
        onContextMenu={onSurfaceContextMenu}
        ref={rootRef}
      >
        {/* The pill's body, which exists only once there is a pill. At rest
          there is nothing beside the avatar to draw, and fading the body in
          as the width grows is what makes the pill unfurl out of the gap
          rather than appear in it. */}
        <span
          className="absolute inset-0 rounded-full border border-white/10 bg-[#17181b]/95 shadow-lg shadow-black/40 transition-opacity duration-200"
          style={{ opacity: expanded ? 1 : 0 }}
          aria-hidden
        />
        {/* The pill's one in-flow row, and where the clearance at either end
          lives. On the row rather than on the pill, so the pill's own box
          goes to nothing at rest while the body inside it keeps being
          measured. */}
        <div
          className="relative flex h-11 shrink-0 items-center"
          style={{ paddingInline: INNER_GAP }}
        >
          <div
            className="relative flex min-w-0 items-center gap-1 overflow-hidden transition-opacity duration-200"
            ref={contentRef}
            // Faded out is not gone: the body stays mounted while collapsed
            // so it can be measured, which would otherwise leave its
            // controls focusable and announced while nothing is drawn.
            // `inert` takes them out of the tab order and the accessibility
            // tree without taking them out of the DOM, so the measurement
            // still works.
            inert={!expanded}
            style={{
              opacity: expanded ? 1 : 0,
              // Contents fade after the body has somewhere to put them, so
              // nothing is ever drawn wider than the pill carrying it.
              transitionDelay: expanded ? "120ms" : "0ms",
            }}
          >
            {phase === "call" ? (
              <CallBody
                call={call}
                assistantName={assistantName}
                watching={watching}
                watchEnabled={watchEnabled}
                onControl={onControl}
                onWatch={onWatch}
              />
            ) : phase === "dictating" && dictating !== undefined ? (
              <DictatingBody
                dictating={dictating}
                dictationText={dictationText}
              />
            ) : phase === "summary" && watchRetro !== undefined ? (
              <SummaryBody retro={watchRetro} onWatchRetro={onWatchRetro} />
            ) : (
              <IdleBody
                spotlight={spotlight}
                watching={watching}
                watchEnabled={watchEnabled}
                onTalk={onTalk}
                onWatch={onWatch}
              />
            )}
          </div>
        </div>
      </div>
      {/* Drawn after the pill so the creature lands over the pill's leading
        edge rather than under it. */}
      <Avatar
        accentHex={accentHex}
        avatarSrc={avatarSrc}
        character={character}
        attentive={hovered}
        // The assistant's own turn. The creature stops blinking and holds a
        // focused, morphing pose, which is the same treatment the chat avatar
        // uses while a reply is streaming: one vocabulary for "it is working"
        // wherever the user meets it.
        busy={assistantWorking}
        // At rest the creature tucks into a capsule. The same answer the pill's
        // own width reads, so the two collapse together and the surface goes to
        // its resting shape as one thing.
        //
        // Except while the introduction is on screen. Its first beat presents
        // the creature by name and deliberately does not open the pill
        // (`introPhase` answers null for `meet`), so the phase is `resting`
        // with a card pointing at a creature that is not drawn. A card
        // introducing the capsule is the one thing this collapse must not do.
        collapsed={!expanded && !introDrawn}
        // The capsule is drawn at one size on every setting, so it counters
        // what this node carries. That is the avatar's box over the authored
        // one: the options scale on the box above cancels against `avatarRel`.
        restingScale={COMPANION_BASE_AVATAR_BOX / avatarBox}
        edge={edge}
        style={{
          left: "50%",
          top: lineAt(cardGrowth, 0),
          // Centred on the point the host put the window around, then
          // scaled about that centre by whatever the creature's own size
          // asks for beyond the options scale the box above already carries.
          // Omitted where the two boxes agree, which is the surface every
          // other length here is authored for. On this node rather than the
          // one below it: the bob owns a `transform` of its own, and two
          // transforms on one node silently leave one of them out.
          transform: `translate(-50%, -50%)${
            avatarRel === 1 ? "" : ` scale(${avatarRel})`
          }`,
        }}
        elementRef={avatarRef}
        onPointerDown={onSurfacePointerDown}
        onContextMenu={onSurfaceContextMenu}
        onClick={onAvatarClick}
      />
      {intro}
    </div>
  );
}

/**
 * The avatar, which is the point the whole surface is arranged around.
 *
 * Positioned on the point the host put the window around rather than laid out
 * in the pill, which is what lets the pill change width and shape underneath
 * without the creature moving a pixel.
 *
 * No light behind the creature. It once sat on a blurred disc of its own
 * accent, and the halo went because it made the creature read as a lit control
 * rather than as something standing on the desktop.
 *
 * **The bob is a wrapper, not a class on the artwork.** `AnimatedAvatar` owns
 * `transform` on its own `<svg>` for the breathe and the morph, and a second
 * animation on that node would silently replace one of them. Everything that
 * belongs to the creature rides inside the wrapper. The edge sits outside it: it is
 * drawn on the shape rather than on the artwork, so a ring saying something is
 * running holds still while the creature breathes under it.
 *
 * **The collapse is a third node, for the same reason.** Fading and shrinking
 * the creature away at rest is a `transform`, and putting it on the bob would
 * silently drop the bob. So the collapse gets a wrapper of its own around the
 * bob, and the two animations stay on separate nodes.
 */
function Avatar({
  accentHex,
  avatarSrc,
  character,
  busy = false,
  attentive = false,
  collapsed = false,
  restingScale = 1,
  edge,
  style,
  elementRef,
  onPointerDown,
  onContextMenu,
  onClick,
}: {
  accentHex: string;
  avatarSrc?: string;
  character?: CompanionCharacter;
  busy?: boolean;
  attentive?: boolean;
  /**
   * Whether the surface is at rest, where the creature gives way to the
   * capsule. See {@link RESTING_HEIGHT}.
   */
  collapsed?: boolean;
  /**
   * What the capsule scales by to undo the scale this node already carries, so
   * it is drawn at one size whatever the creature is sized to. Applies to the
   * capsule alone: the expanded shape is the creature's own box and grows with
   * it, which is the whole point of the setting.
   */
  restingScale?: number;
  /** What the creature's edge is drawing. See `edge` in `CompanionSurface`. */
  edge?: ReactNode;
  style?: CSSProperties;
  elementRef?: Ref<HTMLDivElement>;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onClick?: () => void;
}) {
  // Belt and braces alongside the `prefers-reduced-motion` block beside the
  // keyframes: the class is what a stylesheet-only reader sees, this is what a
  // reader of the component sees.
  const reduce = useReducedMotion();

  return (
    // A div rather than a button even when it is pressable: it is the drag
    // handle for the whole surface, and the press that starts a drag must not
    // read as activating a control. `onClick` fires only for presses the caller
    // decided were not drags.
    <div
      className="absolute grid size-11 cursor-grab place-items-center active:cursor-grabbing"
      style={style}
      ref={elementRef}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onClick={onClick}
    >
      {/* The box the working ring is drawn around: the creature's whole box
        while it is being looked at, the capsule at rest.

        A ring is a statement about the shape it rides, so at rest it hugs the
        capsule rather than circling the empty box the capsule sits in.

        The ring is the only thing this node carries and the node is otherwise
        invisible, because this box grows between the two shapes and anything
        filling it grows with it: an accent inflating to the creature's box and
        dissolving reads as a bubble popping rather than as the creature coming
        out of the pill. The capsule is drawn beside it, at its own size.

        One node either way, never remounted, which is what keeps the one-shot
        capture flare from replaying: see `edge` in `CompanionSurface`. */}
      <div
        className="absolute top-1/2 left-1/2 rounded-full transition-[width,height,transform] duration-300"
        style={{
          width: collapsed ? RESTING_BOX.width : COMPANION_BASE_AVATAR_BOX,
          height: collapsed ? RESTING_BOX.height : COMPANION_BASE_AVATAR_BOX,
          // Centred on the anchor, then scaled about that centre. The scale is
          // stated on both sides rather than only the collapsed one, so the two
          // states are the same transform list and interpolate cleanly.
          transform: `translate(-50%, -50%) scale(${collapsed ? restingScale : 1})`,
          // The easing the pill's own width uses, so the two halves of a
          // surface waking up settle together rather than in sequence.
          transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
          // Nothing travels for a reader who asked for stillness. The shape
          // still changes, it just arrives changed: the fades below are kept,
          // since a cross-fade is not motion across the screen.
          transitionDuration: reduce ? "0s" : undefined,
        }}
      >
        {edge}
      </div>
      {/* The capsule itself, drawn whole in the assistant's own colour.

        The colour is all that is left of the creature at this size, so it is
        the shape rather than a mark on it: a dark lozenge carrying a dot is
        chrome with a light in it, and what this wants to be is the assistant,
        small. It is also what keeps the marker findable on a busy desktop,
        which matters more here than anywhere else on the surface: at rest this
        is the only thing saying the assistant is there at all.

        **It holds its size and fades where it stands.** Sized on itself rather
        than filling the box above, which grows to the creature's. Nothing about
        the resting shape moves: the creature is what grows out of the pill and
        shrinks back into it, and one thing moving is what makes that legible.

        The pill's own material is deliberately not borrowed: a white rim over a
        saturated colour reads as a highlight on it and muddies the one thing
        the shape is for, and it wears no dark rim either; see
        {@link RESTING_BOX}. The shadow stays, since it is what holds any of
        this against a desktop the surface does not own. */}
      <div
        className="companion-capsule absolute top-1/2 left-1/2 rounded-full shadow-lg shadow-black/40 transition-opacity duration-200"
        style={{
          width: RESTING_BOX.width,
          height: RESTING_BOX.height,
          transform: `translate(-50%, -50%) scale(${restingScale})`,
          background: accentHex,
          opacity: collapsed ? 1 : 0,
        }}
        aria-hidden
      />
      {/* Once in a while the creature looks out of the capsule: it rises from
        behind the top or bottom edge far enough to show its eyes, holds a
        moment, and ducks back; see `CompanionPeek`, which is the chat page's
        composer peek over a smaller rim. Only for a composed creature: a
        custom image has nobody to peek. Rides the capsule's transform and
        fade, so it is drawn at the capsule's one size on every setting and
        goes with it when the creature comes out for real. */}
      {character !== undefined ? (
        <CompanionPeek
          character={character}
          capsule={RESTING_BOX}
          // A working creature holds a focused pose, and stops blinking for the
          // same reason. The ring is carrying the state; nothing else should.
          enabled={collapsed && !busy}
          className="absolute top-1/2 left-1/2 transition-opacity duration-200"
          style={{
            transform: `translate(-50%, -50%) scale(${restingScale})`,
            opacity: collapsed ? 1 : 0,
          }}
        />
      ) : null}
      {/* The creature, tucking into the capsule rather than blinking out of
        it. A wrapper of its own because the scale is a `transform` and the bob
        below already owns one. */}
      <div
        className="transition-[opacity,transform] duration-300"
        style={{
          opacity: collapsed ? 0 : 1,
          transform: collapsed ? "scale(0.35)" : "scale(1)",
          transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
          // The scale is dropped for a reader who asked for stillness and the
          // fade is kept: a cross-fade is not motion across the screen, and it
          // is gentler than the creature snapping in and out.
          transitionProperty: reduce ? "opacity" : undefined,
        }}
      >
        <div
          className="companion-avatar-bob relative grid place-items-center"
          style={{ animation: reduce ? "none" : undefined }}
        >
          {character !== undefined ? (
            // The live creature, composed here rather than shipped as pixels. It
            // blinks, twitches and breathes on its own, which is the whole reason
            // the traits cross the bridge instead of a still.
            <div className="relative drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]">
              <AnimatedAvatar
                components={BUNDLED_COMPONENTS}
                traits={character}
                size={AVATAR_IMAGE}
                isAssistantBusy={busy}
                attentive={attentive}
              />
            </div>
          ) : avatarSrc === undefined ? (
            // Until the avatar resolves, a disc in its colour. Same size, so
            // nothing about the geometry moves when the image lands.
            <span
              className="relative size-7 rounded-full drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]"
              style={{ background: accentHex }}
              aria-hidden
            />
          ) : (
            // A custom uploaded image, which has no traits to compose and so no
            // eyes to animate.
            //
            // Undraggable, because the avatar is the surface's drag handle. An
            // image is natively draggable, and the platform's own HTML5 image drag
            // takes the pointer and ends the `mousemove` stream the surface's drag
            // runs on, so pressing a custom avatar would move nothing where
            // pressing a composed creature moves the window. WebKit honours the CSS
            // on paths where it ignores the attribute, so both are needed.
            <img
              src={avatarSrc}
              alt=""
              draggable={false}
              className="relative size-7 rounded-full object-contain drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)] [-webkit-user-drag:none]"
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Expanded, mid-dictation: what the microphone is doing, and nothing else.
 *
 * No controls. Every other open state offers a way to act on itself, and this
 * one is already under the user's hand: the gesture holding the pill open is
 * the control, and letting go is how it ends. A stop button beside a key they
 * are physically holding would be a second answer to a question they have
 * already answered.
 *
 * The word is the same vocabulary a call uses for the same two facts, so a
 * microphone open for dictation and one open for a conversation do not read as
 * different machines.
 */
function DictatingBody({
  dictating,
  dictationText,
}: {
  dictating: CompanionDictating;
  dictationText: string;
}) {
  const { t } = useTranslation();
  const words = dictationText.trim();
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-1">
      <AudioLines className="size-4 shrink-0" aria-hidden />
      {words ? (
        /* The end of the sentence, not the start of it.
 
           A line that filled from the start would freeze on the opening words
           and leave the speaker watching the part they are least unsure of. So
           the words sit at the end of their box, and a run longer than the
           box overflows at the start, where the clipping is. The end is the
           words' own: the box takes its direction from them, so a transcript
           in a right-to-left language ends on the left and is clipped on the
           right, and its last words stay in view the same way.
 
           A stated width rather than a measured one: every other state on
           this surface is as wide as its content, and a sentence has no width
           to be as wide as. The box is the same size with three words in it
           as with thirty, and the same size as the status word's box before
           there were any, so the pill takes its dictating width once and
           holds it while the words change underneath. A box that grew with
           its words would be re-measured on every partial, and the pill's
           width transition would run for as long as the speaker talked.
 
           Not a live region. A recogniser revises its guess several times a
           second, and a screen reader that announced each revision would be
           reading the whole line over and over behind a user who is already
           saying it. */
        <span
          dir="auto"
          className="flex justify-end overflow-hidden text-[12px] whitespace-nowrap text-white/85"
          style={{ width: TRANSCRIPT_WIDTH }}
        >
          <span className="shrink-0">{words}</span>
        </span>
      ) : (
        <span
          className="truncate text-[12px] text-white/85"
          style={{ width: TRANSCRIPT_WIDTH }}
        >
          {dictating === "listening"
            ? t("companionSurface.dictating")
            : t("companionSurface.dictatingTranscribing")}
        </span>
      )}
    </div>
  );
}

/**
 * Expanded, with the app idle: the way in.
 *
 * Verbs throughout. "Talk" is the door: the surface is a place to be on a call
 * with the assistant, and everything else it can do is something done from
 * inside that call. "Teach" is the exception for now, the one where the
 * assistant does the looking rather than the user the saying. It is behind a
 * flag of its own, so the row is Talk alone for anyone who does not have it,
 * and it is on its way into the call row rather than beside the door.
 *
 * **The words are drawn one at a time, under the pointer** (`revealLabel`).
 * This is the row a user meets by resting a hand near the mascot, so it is
 * drawn far more often than it is acted on, and verbs spelled out at once read
 * as a sentence aimed at someone doing something else.
 *
 * Resting as icons keeps the pill to a fraction of the width its labels want,
 * and revealing one at a time is what keeps the reveal legible: exactly one
 * word is ever on the surface, and it is the one the hand is on.
 *
 * `aria-label` carries the name in every state, so a reader gets every control
 * regardless of where the pointer is.
 */
function IdleBody({
  spotlight,
  watching = false,
  watchEnabled = false,
  onTalk,
  onWatch,
}: {
  spotlight?: "talk";
  /** Whether the session Watch starts is already running. */
  watching?: boolean;
  /** Whether Watch is offered at all. See `CompanionSurfaceProps`. */
  watchEnabled?: boolean;
  onTalk?: () => void;
  onWatch?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PillButton
        icon={<AudioLines className="size-4" />}
        label={t("companionSurface.talk")}
        revealLabel
        active={spotlight === "talk"}
        onClick={onTalk}
      />
      {/* Held down for as long as the session runs, so the row says which
          control is holding the pill open and which press ends it. `pressed`
          rather than `active`, because this one is a state and not a look: a
          reader is told a session is running, where everything else this
          surface does about it is a colour they never receive. */}
      <TeachButton
        watching={watching}
        watchEnabled={watchEnabled}
        onWatch={onWatch}
      />
    </>
  );
}

/**
 * The way into a watch session and the way out of it, on whichever row the
 * user is looking at.
 *
 * One control for the two rows that draw it, because it is the same session
 * either way: a screen being read beside an idle pill and one being read
 * beside a call are the same capture, and the same press ends both. Its
 * pressed state is what tells a reader that, and its pinned word is what lets
 * a looking user find the press without hunting under icons.
 *
 * Absent entirely when Watch is not offered, rather than disabled: a user who
 * cannot have the feature is not owed a control that explains itself by
 * refusing them. The pill measures its own contents, so the row simply comes
 * out narrower.
 *
 * **The exit outlives the door.** A session running under a flag that has
 * since been turned off still reads the screen, so the row that would have
 * carried Teach carries the stop instead. Hiding the way in is the whole of
 * what the flag does; leaving a capture with nothing that ends it is not
 * something a flag is allowed to cause.
 */
function TeachButton({
  watching,
  watchEnabled,
  onWatch,
}: {
  watching: boolean;
  watchEnabled: boolean;
  onWatch?: () => void;
}) {
  const { t } = useTranslation();
  if (!watchEnabled) {
    return watching ? <StopWatchingButton onWatch={onWatch} /> : null;
  }
  return (
    <PillButton
      icon={<Eye className="size-4" />}
      label={t("companionSurface.teach")}
      revealLabel
      pressed={watching}
      onClick={onWatch}
    />
  );
}

/**
 * Expanded, after a session: what became of what the user narrated.
 *
 * **Two states and no third.** While the turn runs there is nothing to press,
 * so the row is a word and the ring beside it; once there is a report the row
 * is the question and its two answers. There is no state for a session that
 * produced nothing, because the surface stops drawing this at all when the
 * runtime says so, and an empty result reported as one would be a notice about
 * an absence.
 *
 * **The wait is stated, not implied.** The ring alone would be the same light
 * the assistant burns for every other turn, and the one thing this has to say
 * is which turn it is: the session the user just ended. One word, because the
 * pill is read from the corner of an eye over another app's work.
 *
 * **Both answers are drawn.** The question is asked on a surface that floats
 * over whatever the user does next, so the way out of it has to be as reachable
 * as the way in; a prompt whose only dismissal is going elsewhere is one that
 * follows them around. The summary stays in the assistant's own conversation
 * list either way, which is what makes "not now" a deferral rather than a
 * discard.
 */
function SummaryBody({
  retro,
  onWatchRetro,
}: {
  retro: CompanionWatchRetro;
  onWatchRetro?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  if (retro === "pending") {
    return (
      <span className="ml-1 shrink-0 text-[12px] text-white/85">
        {t("companionSurface.summarizing")}
      </span>
    );
  }
  return (
    <>
      <PillButton
        icon={<ScrollText className="size-4" />}
        label={t("companionSurface.showSummary")}
        showLabel
        onClick={() => {
          onWatchRetro?.(true);
        }}
      />
      <PillButton
        icon={<X className="size-4" />}
        label={t("companionSurface.notNow")}
        showLabel
        onClick={() => {
          onWatchRetro?.(false);
        }}
      />
    </>
  );
}

/**
 * Expanded, mid-call: what the session is doing, and the controls that act on
 * it.
 *
 * **This is the desktop's whole live-voice surface**, so it carries what the
 * iOS Lock Screen card carries: the phase as a glyph and as the session's own
 * wording, elapsed time, and the session's controls. It has one line where that
 * card has several, which is what the choices below are about.
 *
 * **No phase copy of its own.** Every word here is `label` or `detail`, passed
 * through from the session's store, because the phase wording deploys
 * continuously with the web bundle while this surface's shell ships on release
 * cadence. A surface that re-words its own phases is how the two come to
 * disagree.
 *
 * **And no phase glyph.** One belonged here until it collided: a microphone
 * meaning "listening" sat forty pixels from a microphone meaning "mute", and a
 * speaker meaning "speaking" from a speaker meaning "mute the assistant".
 * Adjacent identical glyphs meaning different things is a coin flip, so status
 * moved to the mascot, which is the one element on the pill that is not a
 * control and cannot be mistaken for one.
 */
function CallBody({
  call,
  assistantName,
  watching,
  watchEnabled,
  onControl,
  onWatch,
}: {
  call?: VoiceActivityState;
  assistantName: string;
  watching: boolean;
  watchEnabled: boolean;
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
  onWatch?: () => void;
}) {
  const { t } = useTranslation();
  // The dial: Talk has been pressed and no session has answered. The mutes
  // have nothing to act on yet and a press on them would be dropped, so the
  // row is who is being called and the one control that means something, the
  // end, which is the user changing their mind. Teach stays where it is, so a
  // session already reading the screen does not lose its stop for the beat.
  if (call === undefined) {
    return (
      <>
        <span className="ml-1 max-w-[160px] shrink-0 truncate text-[12px] text-white/85">
          {assistantName === ""
            ? t("companionSurface.calling")
            : t("companionSurface.callingNamed", { name: assistantName })}
        </span>
        <TeachButton
          watching={watching}
          watchEnabled={watchEnabled}
          onWatch={onWatch}
        />
        <EndCallButton onControl={onControl} />
      </>
    );
  }
  // The confirmation takes the row rather than crowding into it. The turn is
  // stopped until it is answered, so it is the only thing here worth pressing,
  // and a pill that tried to carry five controls would make each of them a
  // smaller target than the decision deserves.
  //
  // Teach is among what it excludes. A blocked turn is reading nothing while
  // it waits, and answering it lands back on the row that carries the toggle.
  if (call.approvalRequestId !== "") {
    return (
      <ApprovalBody
        detail={call.detail}
        requestId={call.approvalRequestId}
        onControl={onControl}
      />
    );
  }

  // The activity line when the turn has one, the phase otherwise. `detail` is
  // the more specific of the two ("Reading a file" against "Thinking…") and is
  // empty for most of a call, so this reads as the surface saying more exactly
  // when there is more to say. The mascot carries the state either way.
  const line = call.detail || call.label;
  const { muted, outputMuted } = call;

  return (
    <>
      {/* Sized to its content, not shrunk to fit. The pill measures this row to
          decide how wide to be, so a label that collapses under pressure would
          measure its own collapsed self: the width and the truncation would
          chase each other down. The cap is what keeps a pathological label from
          growing the pill without bound. */}
      <span className="ml-1 max-w-[120px] shrink-0 truncate text-[12px] text-white/85">
        {line}
      </span>
      {/* Beside what the session is doing rather than beside the end control:
          two stops next to each other is a misclick that ends the wrong thing,
          and only one of the two is irreversible. Teach rides the call rather
          than being refused by it: a screen read while talking is a question
          the assistant can answer as it is asked. */}
      <TeachButton
        watching={watching}
        watchEnabled={watchEnabled}
        onWatch={onWatch}
      />
      <PillButton
        icon={
          muted ? <MicOff className="size-4" /> : <Mic className="size-4" />
        }
        label={
          muted
            ? t("companionSurface.unmuteMicrophone")
            : t("companionSurface.muteMicrophone")
        }
        onClick={() => {
          onControl?.(muted ? "unmuteMicrophone" : "muteMicrophone");
        }}
      />
      <PillButton
        icon={
          outputMuted ? (
            <VolumeX className="size-4" />
          ) : (
            <Volume2 className="size-4" />
          )
        }
        label={
          outputMuted
            ? t("companionSurface.unmuteAssistant")
            : t("companionSurface.muteAssistant")
        }
        onClick={() => {
          onControl?.(
            outputMuted ? "unmuteAssistantAudio" : "muteAssistantAudio",
          );
        }}
      />
      <EndCallButton onControl={onControl} />
    </>
  );
}

/**
 * The room's own end control, at pill scale: the same glyph at the same weight
 * in the same destructive tone. Ending a call is the one irreversible thing on
 * this surface, so it looks identical wherever the user meets it, the dial
 * included: there it is the press that takes the request back.
 */
function EndCallButton({
  onControl,
}: {
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <PillButton
      icon={<X className="size-4" strokeWidth={2.5} />}
      label={t("companionSurface.endSession")}
      tone="negative"
      onClick={() => {
        onControl?.("endSession");
      }}
    />
  );
}

/**
 * Answer the confirmation the turn is blocked on.
 *
 * The request id travels with the press so the session answers the question the
 * user was actually shown: between the push that drew these buttons and the
 * press that answers them the request can be decided in the app, time out, or
 * be superseded, and the next one to arrive would be a different question
 * wearing the same buttons.
 */
function ApprovalBody({
  detail,
  requestId,
  onControl,
}: {
  detail: string;
  requestId: string;
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {detail !== "" && (
        <span className="ml-1 max-w-[120px] shrink-0 truncate text-[12px] text-white/85">
          {detail}
        </span>
      )}
      <PillButton
        icon={<Check className="size-4" />}
        label={t("companionSurface.allow")}
        showLabel
        tone="positive"
        onClick={() => {
          onControl?.("approveRequest", requestId);
        }}
      />
      <PillButton
        icon={<X className="size-4" />}
        label={t("companionSurface.deny")}
        showLabel
        tone="negative"
        onClick={() => {
          onControl?.("denyRequest", requestId);
        }}
      />
    </>
  );
}

/**
 * End the watch session, on whichever row the user is looking at.
 *
 * One component for the two that draw it, because the label is the whole of
 * what this control says. It carries no words, so an accessible name that
 * drifted between the idle row and the call row would be two different controls
 * to anyone reading the surface rather than looking at it, and this is the
 * control a user reaches for precisely when they want the reading to stop.
 *
 * An action rather than a toggle, and so no pressed state: it goes one way, and
 * it is drawn only while there is a session for it to end. Its name is what
 * tells a reader both of those things at once, since a control offering to stop
 * the watching is only there when something is being watched.
 */
function StopWatchingButton({ onWatch }: { onWatch?: () => void }) {
  const { t } = useTranslation();
  return (
    <PillButton
      icon={<EyeOff className="size-4" />}
      label={t("companionSurface.stopTeaching")}
      onClick={onWatch}
    />
  );
}

/**
 * A control in the pill.
 *
 * `label` is always the accessible name; it is only drawn when the pill has
 * room for words, which is why the call's controls are icon-only without being
 * unlabelled.
 *
 * **`active` and `pressed` are two props because they are two different
 * claims.** `active` is a look: the demo reel draws a control as though a
 * pointer were on it, and a highlight staged for a recording is not a state the
 * control is in. `pressed` is the control's own on or off, which is a state,
 * and reporting a highlight as one would tell a reader that Talk is switched on
 * because a clip wanted it lit.
 *
 * `pressed` draws the same held-down look, so the state a looking user reads
 * off the background and the state a reader is told cannot come apart.
 */
function PillButton({
  icon,
  label,
  tone,
  showLabel = false,
  revealLabel = false,
  active = false,
  pressed,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tone?: "positive" | "negative";
  showLabel?: boolean;
  /**
   * Draw the label while the pointer is on this control, and not otherwise.
   *
   * **CSS, deliberately, and this is the one place on the surface where that is
   * not a matter of taste.** The host's window is click-through, so the page
   * derives its own hover by hit-testing coordinates against the pill on every
   * forwarded mouse-move rather than trusting `mouseenter`
   * (`companion-surface-page.tsx`). A per-control reveal driven off React's
   * mouse events would be betting on the events that page does not receive.
   * The held-down background on this very button runs on
   * `:hover`, so a reveal on the same mechanism works exactly where the rest of
   * the control does.
   *
   * The pill measures its own contents, so a label appearing resizes this row
   * and the surface grows to fit it on its own. Nothing here has to say how
   * wide the word is.
   */
  revealLabel?: boolean;
  /** Drawn as though the pointer were on it. A look, not a state. */
  active?: boolean;
  /**
   * On or off, for a control that genuinely toggles.
   *
   * Undefined for everything that does not, which is most of this surface: a
   * button reporting a state it does not have is one assistive technology
   * describes wrongly. Where it is set it carries the whole of that state to a
   * reader, since the ring and the held-down background are both things only a
   * looking user gets.
   */
  pressed?: boolean;
  onClick?: () => void;
}) {
  /**
   * A revealed label held open with no pointer in the room.
   *
   * Both cases are ones where the word has to be readable without a hand on the
   * control. `active` is the demo reel pointing at a control, and a control
   * pointed at in a recording nobody can hover is one whose name has to be
   * drawn. `pressed` is a control holding a session open, and the row's job
   * then is to say which press ends it, which it cannot do as an icon the user
   * would have to go looking under.
   */
  const pinned = active || pressed === true;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      // Only where the word is nowhere else. A tooltip over a control that
      // reveals its own label on the same hover is the same word twice, a
      // second later and a few pixels away.
      title={showLabel || revealLabel ? undefined : label}
      onClick={onClick}
      // A press on a control is not the start of a drag. Without this the
      // surface would move under a click meant to activate something on it.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      className={`group flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] transition-colors hover:bg-white/15 ${
        pinned ? "bg-white/15" : ""
      } ${
        tone === "negative"
          ? "text-[#ff6b6b]"
          : tone === "positive"
            ? "text-[#5ee08a]"
            : "text-white/85"
      }`}
    >
      {icon}
      {showLabel && <span>{label}</span>}
      {revealLabel && (
        // `data-label` is the reveal's contract, and it is here because the
        // behaviour itself is a stylesheet: a test running without Tailwind
        // sees a span either way, so the attribute is the only honest way to
        // hold that this word is hidden until the pointer arrives.
        <span
          data-label={pinned ? "pinned" : "hover"}
          className={pinned ? "" : "hidden group-hover:inline"}
        >
          {label}
        </span>
      )}
    </button>
  );
}
