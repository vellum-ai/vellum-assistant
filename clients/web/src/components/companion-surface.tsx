import {
  AudioLines,
  Check,
  Eye,
  EyeOff,
  Mic,
  MicOff,
  Pencil,
  ScreenShare,
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

import type {
  CompanionDictating,
  CompanionDictationOffer,
} from "@vellumai/ipc-contract";
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
  /**
   * Hover: the creature noticing a hand on it.
   *
   * The pill stays shut. **The creature is the call button**, so there is no
   * control to unfurl beside it: it comes out of its capsule, turns attentive,
   * and after a dwell says what a press does, as a name beside it rather than
   * a thing to press.
   */
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
   * Offer: the pill held open by Vellum's version of a dictation another app
   * has already pasted.
   *
   * Nothing on macOS owns a key, so a hold of the voice key with another
   * dictation app running dictates twice. Rather than paste beside that app's
   * words, Vellum shows its own and asks: use them instead, get that app off
   * the key, or leave it. Open regardless of the pointer, for the reason
   * `summary` is: a question waiting on an answer rather than a hint.
   *
   * It ranks below `dictating`, since a new hold is a new question, and above
   * `watching`, since it lasts seconds rather than minutes.
   */
  | "offer"
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
 * The pill the surface rests in, in its two sizes.
 *
 * At rest this used to be a 10pt capsule painted whole in the assistant's
 * colour. It is a pill now, and the difference is the edge: the shape is a lit
 * line in that same colour with nothing inside it, which is findable on a busy
 * desktop where a small block of colour is not, and which takes almost none of
 * the screen away from whatever the user is actually working in.
 *
 * **Two sizes, because the shape answers the pointer.** `idle` is the marker,
 * and it is a marker: the creature is tucked behind it and peeks out of it
 * every few seconds, the way it always has. `active` is what a hand arriving
 * grows it into, big enough for the creature to stand up in. That growth is
 * the whole of what hover does here, and it is why the creature coming out and
 * the pill opening read as one gesture rather than two.
 *
 * **Only `active` scales with the creature.** It has to contain it, so at
 * `ridiculous` it is five times the pill it is at `small`. `idle` is drawn at
 * one size on every setting for the reason the capsule was: sizing the
 * creature is a statement about the creature, and someone who wanted a big
 * mascot when they look at it has not asked for a big lozenge sitting over
 * their work all day. The rim holds at one thickness for the same reason, so
 * the line stays a line instead of thickening into a frame.
 */
const RESTING_PILL = {
  /** The marker. Wider than the artwork it stands in for, and hollow. */
  idle: { width: 48, height: 14 },
  /** What a pointer grows it into: the frame the whole creature stands in. */
  active: { width: 150, height: 35 },
  /** The lit line's thickness, at every size and every setting. */
  rim: 2.5,
  /** How far that line throws light, as the nearer of its two blooms. */
  bloom: 4,
};

/**
 * The box the creature peeks over at rest, which is the idle pill's own.
 *
 * One statement of it, because the pill is drawn at it and `CompanionPeek`
 * measures the creature's rise against it, and two readings of where the rim
 * is would put the eyes somewhere other than on it.
 */
const PEEK_CAPSULE = RESTING_PILL.idle;

/**
 * The resting pill's edge: one lit line in the assistant's colour, the light it
 * throws, and the shadow that holds it off a desktop this surface does not own.
 *
 * Two blooms rather than one. The tight one keeps the line reading as a line
 * at a glance, and the wide one is what separates the shape from a busy
 * wallpaper behind it; either alone reads as a smudge or as a sticker.
 */
const restingRim = (accentHex: string, rim: number, bloom: number): string =>
  [
    `inset 0 0 0 ${rim}px color-mix(in srgb, ${accentHex} 78%, transparent)`,
    `0 0 ${bloom}px color-mix(in srgb, ${accentHex} 85%, transparent)`,
    `0 0 ${bloom * 4}px color-mix(in srgb, ${accentHex} 42%, transparent)`,
    "0 8px 24px rgba(0, 0, 0, 0.45)",
  ].join(", ");

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
 * How long a hand rests on the creature before it is told what a press does.
 *
 * Long enough that a pointer passing through is told nothing, short enough
 * that a hand that stopped to look is answered while it is still looking.
 */
export const NAME_DWELL_MS = 500;

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
 * The width of the offer's line in the pill: a few words and, where there is
 * one, the other app's name. The words themselves are on the card beside it.
 */
const OFFER_WIDTH = 200;

/**
 * The width of the call's status line: what the session is doing, and where
 * the turn says more than its phase does, what it is doing it to.
 *
 * Stated for the reason the transcript's is. The line is passed through from
 * the session, so it changes several times a call ("Listening…" to
 * "Thinking…" to "Reading a file"), and a box as wide as its content
 * would hand the pill a different width for each of them: the bar would
 * breathe in and out under the user's hand while the controls on it slid
 * sideways, on a surface that floats over another app's work. So the line has
 * one width whatever is in it, the pill takes its call width once, and a line
 * longer than the box is truncated rather than bought room for.
 *
 * Wide enough for the phase copy in the languages the app ships, with room for
 * the short activity lines a turn adds; anything past that is a line long
 * enough that its first words are the ones worth reading.
 */
const CALL_LINE_WIDTH = 120;

/**
 * The controls at the end of the call row, together: five buttons of a
 * 16-point glyph in 8 points of padding either side, the gap between each
 * pair, and the gap between the line and the first of them.
 *
 * Only used to state the call's fallback below, which is exact rather than a
 * guess now that the line beside them has a width of its own.
 */
const CALL_CONTROLS_WIDTH = 5 * 32 + 5 * 4;

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
 * The two phases that never reach this are absent from it: `resting` and
 * `hover` draw no pill.
 */
export const FALLBACK_WIDTHS: Record<
  Exclude<CompanionSurfacePhase, "resting" | "hover">,
  number
> = {
  // The stop of a session reading the screen, which is the one control the
  // idle row ever carries: the way in is the creature itself.
  watching: 40,
  // Two labelled controls, both drawn: this row is a question waiting on an
  // answer rather than a set of ways in, so its words are not the pointer's to
  // reveal. That is what makes it wider than the idle row it stands in for.
  summary: 220,
  // The transcript box beside the icon and the row's own clearance. The box
  // has a stated width whatever is in it, so this is the state's actual width
  // rather than a guess at one.
  dictating: TRANSCRIPT_WIDTH + 32,
  // The offer's line beside the icon and the row's own clearance, with a
  // stated width for the reason the transcript's has one.
  offer: OFFER_WIDTH + 32,
  // The line and the five controls of the handlebar, which is the widest a
  // call draws: Teach and Share are absent on a page that offers neither, and
  // the dial and the approval both stand fewer controls in the same row. The
  // line has a stated width, so this is the state's actual width rather than a
  // guess at one.
  // The `4` is the line's own lead-in, which is a margin rather than one of
  // the row's gaps.
  call: 4 + CALL_LINE_WIDTH + CALL_CONTROLS_WIDTH,
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
   * The pill the surface rests in, for the host to hit-test the same way it
   * hit-tests the pill that carries content.
   *
   * Its own ref because exactly one of the two is ever drawn, and the window
   * has to be armed over whichever it is. Without this the resting pill is a
   * 150pt shape the pointer falls straight through into whatever application
   * is behind it, which is the surface being visible and unreachable at the
   * one time it is on screen all day.
   */
  restingPillRef?: Ref<HTMLDivElement>;
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
   * Draw the creature's name for a press as though the hand had dwelt on it.
   *
   * Real hover needs no help. This is for playback with no pointer in the
   * room, where a hand reaching for the creature is the whole point of the
   * frame.
   */
  spotlight?: "talk";
  /**
   * Start or stop the session that reads the screen, which is what Watch does.
   *
   * One press for both edges, the way the contract's `toggleWatch` is: the
   * surface draws a single control, and the side holding the session is the
   * only one that knows which edge a press is.
   */
  onWatch?: () => void;
  /**
   * The press of Teach with no session running, when the surface has something
   * to do with it other than start one: open the picker.
   *
   * Its own callback rather than a flag on {@link CompanionSurfaceProps.onWatch}
   * because the two presses go different places. A stop is the session's and
   * leaves for the window that owns it; the way in, when there is a choice to
   * make first, stays on the page that draws the choice. Absent, Teach starts
   * the session the way it always did.
   */
  onTeach?: () => void;
  /**
   * Whether the picker Teach opens is on screen, which draws Teach held down
   * for as long as it is. The card itself arrives on
   * {@link CompanionSurfaceProps.picker}.
   */
  picking?: boolean;
  /**
   * Whether the call is being shown the screen, which draws Share held down
   * for as long as it is. Its own prop for the reason `watching` is: it is
   * the session's, and the control that ends it belongs to the share rather
   * than to whatever the pill is drawing.
   */
  sharing?: boolean;
  /**
   * Whether Share is offered on the call row at all, which is whether the
   * window holding the session says the session can be shown anything. Off
   * unless positively on, the way {@link CompanionSurfaceProps.watchEnabled}
   * is read, and for the same reason: the control starts capturing the
   * user's screen.
   */
  shareEnabled?: boolean;
  /**
   * Whether the picker Share opens is on screen, which draws Share held down
   * for as long as it is. The card itself arrives on
   * {@link CompanionSurfaceProps.picker}, the same slot Teach's does.
   */
  sharePicking?: boolean;
  /** The press of Share with nothing shared: open the picker. */
  onShare?: () => void;
  /**
   * The press of Share while something is shared: the stop. Its own
   * callback rather than a toggle, the split {@link CompanionSurfaceProps.onTeach}
   * makes: the way in stays on the page that draws the choice, and the stop
   * leaves for the window that owns the session.
   */
  onStopShare?: () => void;
  /**
   * Whether the frame around the shared surface is taking the mouse, which
   * draws Draw held down for as long as it is.
   *
   * The one state on this row that is the shell's rather than the session's:
   * it is a fact about a window the shell opened. Off unless positively on,
   * the way {@link CompanionSurfaceProps.watching} is read, and for a version
   * of the same reason: a control drawn held down over a frame that is not
   * taking presses is a promise about where the user's next click goes.
   */
  annotating?: boolean;
  /**
   * The press of Draw, carrying the state it is asking for rather than being
   * a toggle. The mode is the shell's and the shell may refuse it (a share
   * that has ended takes it down), so the press says what it wants and the
   * pushed state says what happened.
   */
  onAnnotate?: (annotating: boolean) => void;
  /**
   * Press the avatar. Idle, that starts a call; on a call, it goes back to
   * Vellum, on the conversation the call is in. The caller decides which,
   * since it is the side holding the session; this side only names the press
   * for a reader, by the phase.
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
   * A dictation's words while the offer of them stands, and why they were
   * not simply typed where the user was. Its own prop for the reason
   * {@link CompanionSurfaceProps.watchRetro} is: a call outranks the phase,
   * and an offer must not lose its answer because the user picked up the
   * phone.
   */
  dictationOffer?: CompanionDictationOffer;
  /**
   * The card offering those words and the answers to them, drawn beside the
   * surface while the offer stands. Composed by the caller for the reason the
   * picker is: the card is a sibling of the pill, and the page that owns the
   * answer owns it.
   */
  offer?: ReactNode;

  /**
   * Whether Teach is offered on the call row at all, which is the feature flag
   * rather than any fact about a session.
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
   * The picker Teach opens, drawn beside the surface while a choice is being
   * made. Composed by the caller for the reason the introduction is: the card
   * is a sibling of the pill, and the page that owns the choice owns it.
   */
  picker?: ReactNode;
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
  restingPillRef,
  avatarRef,
  onSurfacePointerDown,
  onSurfaceContextMenu,
  spotlight,
  onWatch,
  onTeach,
  picking = false,
  sharing = false,
  shareEnabled = false,
  sharePicking = false,
  onShare,
  onStopShare,
  annotating = false,
  onAnnotate,
  onAvatarClick,
  working = false,
  watching = false,
  watchRetro,
  onWatchRetro,
  dictationOffer,
  offer,
  watchEnabled = false,
  dictating,
  dictationText = "",
  call,
  onControl,
  intro,
  picker,
}: CompanionSurfaceProps) {
  const { t } = useTranslation();
  /**
   * Whether the pill is drawn.
   *
   * The pill is the row of a state the user is in, never a menu: the call's
   * bar, the words being dictated, a summary's question, the stop of a session
   * reading the screen. Hover opens nothing, because the creature is the call
   * button and there is nothing else on an idle surface to offer.
   */
  /**
   * Whether the creature is out of the pill's idle size and standing in it,
   * which the pointer alone does: every phase past hover draws a pill with
   * something in it, and the creature stands beside that one.
   */
  const creatureOut = phase !== "resting";
  const expanded =
    phase === "call" ||
    phase === "dictating" ||
    phase === "offer" ||
    phase === "summary" ||
    phase === "watching";
  /**
   * Whether the hand has dwelt on the creature long enough to be told its
   * name for a press.
   *
   * A dwell rather than the hover's first frame, so a pointer crossing the
   * surface on the way somewhere else is not told anything, and a word that
   * arrives after a beat reads as the creature answering a look rather than
   * as a label that was always there.
   */
  const [dwelt, setDwelt] = useState(false);
  useEffect(() => {
    if (phase !== "hover") {
      setDwelt(false);
      return;
    }
    const timer = setTimeout(() => {
      setDwelt(true);
    }, NAME_DWELL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [phase]);
  const named = spotlight === "talk" || (phase === "hover" && dwelt);
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
  const reduce = useReducedMotion();
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

  // The distances everything below is placed by, in points, and the one
  // conversion into the units this layout is stated in. Shared with
  // `CompanionIntro`, whose card hangs off the same creature.
  const {
    scale,
    avatarRel,
    avatarHalf,
    baseline,
    gap,
    inUnits,
    lineAt,
    edgeAt,
  } = companionLayoutFor(avatarBox, optionsBox);

  /**
   * Whether the pill is the call's bar.
   *
   * **The call is clearly not the pill, but a form of it.** Every other phase
   * is the pill hanging off the creature's side; on a call the bar is centred
   * on the point the host put the window around instead, lit at its edge in
   * the assistant's colour, and the host takes the whole thing to the bottom
   * of the display the way a meeting's controls sit. The creature stands
   * beside the bar across the gap it keeps from every other pill: the
   * controls are the call's and the creature is the one on the call, and two
   * objects with daylight between them is how that reads.
   */
  const inCall = phase === "call";

  // The body and the clearance at either end of it, and nothing else: the
  // avatar has a box of its own beside the pill rather than a column inside it.
  const width = !expanded
    ? 0
    : (contentWidth ?? FALLBACK_WIDTHS[phase]) + 2 * INNER_GAP;

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
   * The creature's box over the one this file's lengths are authored for.
   *
   * The activated pill takes it, because it has to contain the creature; the
   * idle marker and the rim do not. See {@link RESTING_PILL}.
   */
  const restingScale = avatarBox / COMPANION_BASE_AVATAR_BOX;

  /**
   * The resting pill's box: the marker, or what a pointer has grown it into.
   *
   * Read off `creatureOut` rather than off `hovered`, so the one thing that
   * decides whether the creature is standing decides whether there is
   * anywhere for it to stand. The two are the same gesture.
   */
  const restingBox = creatureOut
    ? {
        width: RESTING_PILL.active.width * restingScale,
        height: RESTING_PILL.active.height * restingScale,
      }
    : RESTING_PILL.idle;

  /**
   * Whether the introduction's card is drawn beside the surface.
   *
   * `null` is what the host passes when there is no beat to draw and
   * `undefined` is what a caller that never mentions it leaves behind, and both
   * mean the same thing. Named rather than tested inline, because the one thing
   * that reads it is deciding whether the creature is on screen at all.
   */
  const introDrawn = intro !== null && intro !== undefined;

  const style: CSSProperties = inCall
    ? {
        width,
        // **Centred on the creature's own point.** The bar takes the point
        // the creature holds everywhere else and stands on its centre line
        // rather than on its baseline, and the canvas is symmetric about
        // that point, so the host centring the canvas on the display centres
        // the bar.
        left: "50%",
        top: lineAt(cardGrowth, 0),
        transform: "translate(-50%, -50%)",
        transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
      }
    : {
        width,
        ...placement,
        // **On the creature's visible bottom.** The pill's bottom edge sits on
        // the bottom of the artwork, so the two keep one baseline whatever the
        // pill is carrying. The line is the artwork, not the avatar's *box*,
        // which runs an `INNER_GAP` further down to hold the bob's slack.
        // Which edge of the canvas that line is measured from is the host's
        // call (see `CompanionSurfaceCardGrowth`).
        top: lineAt(cardGrowth, baseline),
        transform: "translateY(-100%)",
        // Settles rather than overshoots. A surface on screen all day should
        // not bounce every time the pointer crosses it.
        transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
      };

  /**
   * Where the creature is drawn: on the point the host put the window around,
   * or, on a call, beside the bar's leading end.
   *
   * The bar is centred on that point and its width is known here, so the
   * creature is a fixed step back from the centre: half the bar, then the gap
   * and its own half box, which are the distances the pill steps off the
   * creature by everywhere else, read the other way round. The creature slides
   * out as the bar unfurls and back as it collapses, over the pill's own
   * duration, so the two read as one object changing shape.
   */
  const creatureLeft = inCall
    ? `calc(50% - ${width / 2 + inUnits(avatarHalf + gap)}px)`
    : "50%";

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
        className={`absolute flex h-11 cursor-grab items-center rounded-full transition-[width] duration-300 select-none will-change-[width] active:cursor-grabbing ${!inCall && growth === "left" ? "justify-end" : ""}`}
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
        {/* The call's own light: a pulse travelling the bar's edge in the
            assistant's colour, the same ring the creature burns for a turn and
            a watch session burns in amber. On the edge and nowhere inside it,
            so the bar stays the pill it was and the call is the thing moving
            around it. */}
        {inCall && (
          <span
            className="companion-working-ring pointer-events-none absolute -inset-0.5 rounded-full transition-opacity duration-200"
            style={{
              opacity: expanded ? 1 : 0,
              ["--companion-ring-accent" as string]: accentHex,
            }}
            aria-hidden
          />
        )}
        {/* The pill's one in-flow row, and where the clearance at either end
          lives. On the row rather than on the pill, so the pill's own box
          goes to nothing at rest while the body inside it keeps being
          measured. */}
        <div
          className="relative flex h-11 shrink-0 items-center"
          style={{ paddingInline: INNER_GAP }}
        >
          <div
            // Not positioned, on purpose: the controls' captions stand above
            // this row and would be clipped by it, and an absolute box escapes
            // its ancestors' clipping only while its containing block is
            // outside them. See `PillButton`.
            className="flex min-w-0 items-center gap-1 overflow-hidden transition-opacity duration-200"
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
                picking={picking}
                sharing={sharing}
                shareEnabled={shareEnabled}
                sharePicking={sharePicking}
                annotating={annotating}
                onControl={onControl}
                onWatch={onWatch}
                onTeach={onTeach}
                onShare={onShare}
                onStopShare={onStopShare}
                onAnnotate={onAnnotate}
              />
            ) : phase === "dictating" && dictating !== undefined ? (
              <DictatingBody
                dictating={dictating}
                dictationText={dictationText}
              />
            ) : phase === "summary" && watchRetro !== undefined ? (
              <SummaryBody retro={watchRetro} onWatchRetro={onWatchRetro} />
            ) : phase === "offer" && dictationOffer !== undefined ? (
              <OfferBody offer={dictationOffer} />
            ) : (
              <IdleBody watching={watching} onWatch={onWatch} />
            )}
          </div>
        </div>
      </div>
      {/* The pill the surface rests in: the assistant's own colour as a lit
        edge and nothing inside it. A marker with the creature tucked behind
        it until a pointer arrives, then grown to the size the creature stands
        up in. See {@link RESTING_PILL}.

        A sibling of the pill that carries content rather than the same
        element, and the two cross-fade. They are different shapes in different
        places: this one is centred on the creature the way the call's bar is,
        and every pill with something in it hangs off the creature's side. One
        element animating between the two would have to jump its anchor from
        the centre to an edge mid-transition, which reads as the surface
        flinching.

        A drag handle, as the creature and the pill both are. It is the largest
        thing on screen at rest, so it is what a hand reaches for to move the
        surface, and a 150pt shape that ignored the press would read as broken.
        `aria-hidden` because it says nothing the creature beside it does not
        already say: the creature carries the accessible name and the press. */}
      <div
        className="absolute cursor-grab rounded-full transition-[width,height,opacity] duration-300 active:cursor-grabbing"
        style={{
          width: inUnits(restingBox.width),
          height: inUnits(restingBox.height),
          // Centred on the point the host put the window around, which is the
          // point the creature holds. The creature is a sibling drawn on that
          // same point, so centring the pill on it is what puts the creature
          // in the middle of the pill without either one being laid out in
          // terms of the other.
          left: "50%",
          top: lineAt(cardGrowth, 0),
          transform: "translate(-50%, -50%)",
          boxShadow: restingRim(
            accentHex,
            inUnits(RESTING_PILL.rim),
            inUnits(RESTING_PILL.bloom),
          ),
          // Gone the moment there is a pill with something in it. Not
          // unmounted: the fade is what makes the two read as one surface
          // changing shape rather than one object replacing another.
          opacity: expanded ? 0 : 1,
        }}
        onPointerDown={onSurfacePointerDown}
        onContextMenu={onSurfaceContextMenu}
        ref={restingPillRef}
        aria-hidden
      />
      {/* The creature's name for a press, the way the Dock names an icon: a
          small label centred above it rather than a control standing beside
          it.

          Above and centred rather than beside, unlike the pill: this is the
          shape of a name a Mac user already reads as "what this icon is
          called", not "something to press", so it does not have to invent a
          visual language of its own to avoid looking pressable. A name and
          not a control either way: it takes no pointer, and the press it
          names is the creature's. `aria-hidden` because the creature carries
          the same word as its accessible name, and a reader told it twice is
          told about two things. Mounted throughout and faded, so its arrival
          after the dwell is a fade rather than a pop. */}
      <Caption
        className={named ? "opacity-100" : "opacity-0"}
        data-companion-name={named ? "shown" : "hidden"}
        style={{
          left: "50%",
          top: lineAt(cardGrowth, 0),
          // Pulled up by the avatar's own half-box (a true point value, so it
          // goes through `inUnits` the way `edgeAt`/`lineAt` do) plus a few
          // flat pixels in the caption's own authored scale: enough that the
          // beak lands on the avatar's edge rather than short of it.
          transform: `translate(-50%, calc(-100% - ${inUnits(avatarHalf)}px - 4px))`,
        }}
        label={t("companionSurface.talk")}
      />
      {/* Drawn after the pill so the creature lands over the pill's leading
        edge rather than under it. */}
      <Avatar
        // The press's name, by the phase, since the caller decides what the
        // press does by the same fact: a call's creature goes back to Vellum,
        // an idle one starts a call.
        label={
          phase === "call"
            ? t("companionSurface.openVellum")
            : t("companionSurface.talk")
        }
        accentHex={accentHex}
        avatarSrc={avatarSrc}
        character={character}
        attentive={hovered}
        // The assistant's own turn. The creature stops blinking and holds a
        // focused, morphing pose, which is the same treatment the chat avatar
        // uses while a reply is streaming: one vocabulary for "it is working"
        // wherever the user meets it.
        busy={assistantWorking || watching || summarizing}
        // At rest the creature is tucked behind the marker and peeks out of
        // it. The same answer the resting pill's own box reads, so the pill
        // grows as the creature stands up and the two are one gesture.
        //
        // Except while the introduction is on screen. Its first beat presents
        // the creature by name and deliberately does not open the pill
        // (`introPhase` answers null for `meet`), so the phase is `resting`
        // with a card pointing at a creature that is not drawn. A card
        // introducing an empty marker is the one thing this must not do.
        collapsed={!creatureOut && !introDrawn}
        // The peek rides the marker, which is drawn at one size on every
        // setting, so it counters what this node carries. That is the avatar's
        // box over the authored one: the options scale on the box above
        // cancels against `avatarRel`.
        restingScale={COMPANION_BASE_AVATAR_BOX / avatarBox}
        style={{
          left: creatureLeft,
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
          // The slide out beside the call bar and back, on the pill's own
          // easing and duration so the two move as one. Nothing travels for a
          // reader who asked for stillness: the creature arrives beside the
          // bar.
          transition: reduce
            ? undefined
            : "left 300ms cubic-bezier(.2,.8,.2,1)",
        }}
        elementRef={avatarRef}
        onPointerDown={onSurfacePointerDown}
        onContextMenu={onSurfaceContextMenu}
        onClick={onAvatarClick}
      />
      {intro}
      {picker}
      {offer}
    </div>
  );
}

/**
 * The name's fill, named once and shared by the rectangle and its beak.
 *
 * A shared constant rather than the same literal typed twice. Translucent
 * rather than the flat fill this had before `backdrop-filter` was added:
 * the blur only has something to show once the fill lets it through. The
 * beak sits flush against the rectangle's bottom edge rather than
 * overlapping it (`top-full`, not a negative offset), so the two panes of
 * blurred backdrop meet edge to edge instead of compositing on top of each
 * other, which is what kept the flat-fill version seam-free and keeps this
 * one seam-free too.
 */
const NAME_CAPTION_FILL = "rgba(28, 28, 30, 0.55)";

/**
 * The blur and saturation boost shared by the rectangle and its beak, so the
 * one pane of "glass" reads as one material rather than two.
 *
 * An approximation of macOS's own vibrancy material, not the real thing: a
 * genuine `NSGlassEffectView` is a native layer, and this is HTML painted
 * inside the window's own transparent content, so the closest available
 * tool is Chromium's `backdrop-filter` sampling the desktop showing through
 * that transparency.
 */
const NAME_CAPTION_GLASS = "backdrop-blur-md backdrop-saturate-150";

/**
 * A name for a thing under the pointer, the way the Dock names an icon: a
 * small rectangle above it with a beak pointing down at it. The creature's
 * name for a press, and each pill control's name for the pointer on it.
 *
 * Text only, no icon: what sits beneath it is the icon already, and the
 * Dock's own tooltip carries nothing but the name. A small rectangle rather
 * than the pill's stadium shape, so the two never share a silhouette.
 *
 * Placed by the caller: `className` carries whether it is shown and any lift
 * off the thing it names, `style` any offsets the layout works out. Absolute
 * with no offsets of its own, so a caller that sets none gets the static
 * position, which is what the pill's controls rely on.
 *
 * `aria-hidden` throughout: whatever it names carries the same word as its
 * accessible name, and a reader told it twice is told about two things.
 */
function Caption({
  className,
  style,
  label,
  ...data
}: {
  className: string;
  style?: CSSProperties;
  label: string;
} & Partial<Record<`data-${string}`, string>>) {
  return (
    <span
      className={`pointer-events-none absolute rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap text-white/90 shadow-md shadow-black/30 transition-opacity duration-200 ${NAME_CAPTION_GLASS} ${className}`}
      style={{ ...style, backgroundColor: NAME_CAPTION_FILL }}
      aria-hidden
      {...data}
    >
      {label}
      {/* Flush with the rectangle's own bottom edge (`top-full`) rather than
          nudged down to meet it, so the two blurred panes meet at a seam
          rather than compositing on top of each other. Centred under the
          text rather than under the whole padded box for the same reason a
          Dock label's beak centres on the name: it is pointing at the icon
          below, and the icon is what the horizontal centre of this box was
          already placed over.

          Clipped to a triangle rather than drawn with the border trick:
          `backdrop-filter` blurs an element's whole border box, transparent
          border colour or not, so the border trick left a hazy rectangular
          smudge around the visible point. `clip-path` removes those corners
          from the element entirely, so there is nothing left there for the
          blur to show through. */}
      <span
        className={`absolute top-full left-1/2 h-1.5 w-2.5 -translate-x-1/2 ${NAME_CAPTION_GLASS}`}
        style={{
          backgroundColor: NAME_CAPTION_FILL,
          clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        }}
        aria-hidden
      />
    </span>
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
  label,
  style,
  elementRef,
  onPointerDown,
  onContextMenu,
  onClick,
}: {
  accentHex: string;
  /** The press's accessible name. See `onAvatarClick` in `CompanionSurface`. */
  label: string;
  avatarSrc?: string;
  character?: CompanionCharacter;
  busy?: boolean;
  attentive?: boolean;
  /**
   * Whether the surface is at rest, where the creature is tucked behind the
   * marker and peeks out of it. See {@link RESTING_PILL}.
   */
  collapsed?: boolean;
  /**
   * What the peek scales by to undo the scale this node already carries, so it
   * rides a marker drawn at one size whatever the creature is sized to.
   * Applies to the peek alone: the standing creature is its own box and grows
   * with it, which is the whole point of the setting.
   */
  restingScale?: number;
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
      role="button"
      aria-label={label}
      className="absolute grid size-11 cursor-grab place-items-center active:cursor-grabbing"
      style={style}
      ref={elementRef}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onClick={onClick}
    >
      {/* Once in a while the creature looks out of the marker: it rises from
        behind the top or bottom edge far enough to show its eyes, holds a
        moment, and ducks back; see `CompanionPeek`. Only for a composed
        creature: a custom image has nobody to peek.

        The pill it rises over is hollow, which costs the peek nothing: the
        rise is drawn through a clip that shows only the slice above the rim,
        so what hides the rest of the creature is the clip and never the fill.

        Rides the marker's own scale and fade, so it is drawn at the marker's
        one size on every setting and goes with it when the creature comes out
        for real. */}
      {character !== undefined ? (
        <CompanionPeek
          character={character}
          capsule={PEEK_CAPSULE}
          // A working creature holds a focused pose, and stops blinking for the
          // same reason. The creature is carrying the state; nothing else
          // should.
          enabled={collapsed && !busy}
          className="absolute top-1/2 left-1/2 transition-opacity duration-200"
          style={{
            transform: `translate(-50%, -50%) scale(${restingScale})`,
            opacity: collapsed ? 1 : 0,
          }}
        />
      ) : null}
      {/* The creature standing up out of the marker, rather than blinking into
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
 * The pill's line while a dictation's words are on offer beside it.
 *
 * Only why they are being offered: the other app that pasted its own version,
 * or that nothing in front would take them. The words and the answers are on
 * the card ({@link CompanionSurfaceProps.offer}), since the pill is one line
 * tall and the words have to be read whole.
 */
function OfferBody({ offer }: { offer: CompanionDictationOffer }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-1">
      <AudioLines className="size-4 shrink-0" aria-hidden />
      <span
        className="truncate text-[12px] text-white/85"
        style={{ width: OFFER_WIDTH }}
      >
        {offer.reason === "claimed"
          ? t("companionSurface.offerHeard", { app: offer.app })
          : t("companionSurface.offerNowhere")}
      </span>
    </div>
  );
}

/**
 * Expanded with no call and no words: the row of a session reading the screen.
 *
 * **The way in is the creature, not a control.** Talk is a press on the
 * creature itself, and Teach is done from inside the call on the call row, so
 * the idle row has nothing to offer a hand that is only looking. What it
 * carries is the way out: a session already reading the screen, started in
 * the app or under a call that has since ended, has to stay stoppable from
 * wherever the user looks, so the stop rides here for as long as it runs.
 */
function IdleBody({
  watching = false,
  onWatch,
}: {
  /** Whether a session is reading the screen. */
  watching?: boolean;
  onWatch?: () => void;
}) {
  return <>{watching && <StopWatchingButton onWatch={onWatch} />}</>;
}

/**
 * The way into a watch session and the way out of it, on the call row.
 *
 * One control for both edges, held down for as long as the session runs, so
 * the row says which press ends it. `pressed` because this one is a state and
 * not a look: a reader is told a session is running, where everything else
 * this surface does about it is a colour they never receive.
 *
 * Absent entirely when Watch is not offered, rather than disabled: a user who
 * cannot have the feature is not owed a control that explains itself by
 * refusing them. The pill measures its own contents, so the row simply comes
 * out narrower.
 *
 * **The exit outlives the door.** A session running under a flag that has
 * since been turned off still reads the screen, so the row that would have
 * carried Teach carries the stop instead, the same stop the idle row draws.
 * Hiding the way in is the whole of what the flag does; leaving a capture
 * with nothing that ends it is not something a flag is allowed to cause.
 *
 * **The way in may be a question first.** Where the page can ask what to
 * read, the press with no session running opens its picker rather than a
 * session, and Teach is drawn held down for the asking; the pick is what
 * starts the session. The stop is never a question.
 */
function TeachButton({
  watching,
  watchEnabled,
  picking,
  onWatch,
  onTeach,
}: {
  watching: boolean;
  watchEnabled: boolean;
  picking: boolean;
  onWatch?: () => void;
  onTeach?: () => void;
}) {
  const { t } = useTranslation();
  if (!watchEnabled) {
    return watching ? <StopWatchingButton onWatch={onWatch} /> : null;
  }
  return (
    <PillButton
      icon={<Eye className="size-4" />}
      label={t("companionSurface.teach")}
      // Held down for the session and for the choice before it alike: both
      // are states this press is in the middle of, and the second press ends
      // either one.
      pressed={watching || picking}
      // The stop is the session's whatever the page wants of a start. A page
      // with no picker leaves `onTeach` unset and both edges take `onWatch`,
      // which is the toggle it always was.
      onClick={watching ? onWatch : (onTeach ?? onWatch)}
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
  picking,
  sharing,
  shareEnabled,
  sharePicking,
  annotating,
  onControl,
  onWatch,
  onTeach,
  onShare,
  onStopShare,
  onAnnotate,
}: {
  call?: VoiceActivityState;
  assistantName: string;
  watching: boolean;
  watchEnabled: boolean;
  picking: boolean;
  sharing: boolean;
  shareEnabled: boolean;
  sharePicking: boolean;
  annotating: boolean;
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
  onWatch?: () => void;
  onTeach?: () => void;
  onShare?: () => void;
  onStopShare?: () => void;
  onAnnotate?: (annotating: boolean) => void;
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
          picking={picking}
          onWatch={onWatch}
          onTeach={onTeach}
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
      {/* One width, whatever the session is saying. See
          {@link CALL_LINE_WIDTH}. `shrink-0` because the pill measures this row
          to decide how wide to be, and a box that collapsed under pressure
          would measure its own collapsed self: the width and the truncation
          would chase each other down. */}
      <span
        className="ml-1 shrink-0 truncate text-[12px] text-white/85"
        style={{ width: CALL_LINE_WIDTH }}
      >
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
        picking={picking}
        onWatch={onWatch}
        onTeach={onTeach}
      />
      {/* Beside Teach, since the two are the same gesture aimed at different
          ends: Teach has the screen read for a lesson, Share has it shown to
          the call. Not on the dial, where there is no session to show. */}
      <ShareButton
        sharing={sharing}
        shareEnabled={shareEnabled}
        sharePicking={sharePicking}
        onShare={onShare}
        onStopShare={onStopShare}
      />
      {/* Behind Share and only while one is running, because it acts on what
          is being shared: there is nothing to draw on until there is. */}
      <DrawButton
        sharing={sharing}
        annotating={annotating}
        onAnnotate={onAnnotate}
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
 * Show the call the screen, or stop, on the call row beside Teach.
 *
 * The same shape as {@link TeachButton}, edge for edge: absent entirely where
 * the call cannot be shown anything rather than disabled, held down for the
 * share and for the choice before it, and the stop is the press on the held
 * control and never a question. A share already running when the answer
 * turns negative keeps its stop, for the reason Teach's exit outlives its
 * door.
 *
 * One name for both edges, the way Teach has one: the held-down state and
 * `aria-pressed` say which press this is, and a control that renamed itself
 * to "Stop" would be a caption where the row wants an affordance.
 */
function ShareButton({
  sharing,
  shareEnabled,
  sharePicking,
  onShare,
  onStopShare,
}: {
  sharing: boolean;
  shareEnabled: boolean;
  sharePicking: boolean;
  onShare?: () => void;
  onStopShare?: () => void;
}) {
  const { t } = useTranslation();
  if (!shareEnabled && !sharing) {
    return null;
  }
  return (
    <PillButton
      icon={<ScreenShare className="size-4" />}
      label={t("companionSurface.share")}
      pressed={sharing || sharePicking}
      onClick={sharing ? onStopShare : onShare}
    />
  );
}

/**
 * Draw on what the call is being shown, on the call row behind Share.
 *
 * Absent unless a share is running, rather than disabled: it acts on the
 * shared surface, and before there is one it is not a control that is
 * unavailable, it is a control with nothing to be about. The same reason
 * {@link ShareButton} is absent off a call.
 *
 * The one control on this row whose press changes what the *desktop* does
 * rather than what the session does: while it is held down the frame around
 * the shared surface takes the mouse, so a press out there is a mark instead
 * of a click on the app underneath. That is a big thing to do quietly, which
 * is why it is a mode with a control drawn held down for as long as it lasts
 * rather than something that happens on a modifier nobody can see.
 */
function DrawButton({
  sharing,
  annotating,
  onAnnotate,
}: {
  sharing: boolean;
  annotating: boolean;
  onAnnotate?: (annotating: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!sharing) {
    return null;
  }
  return (
    <PillButton
      icon={<Pencil className="size-4" />}
      label={t("companionSurface.draw")}
      pressed={annotating}
      onClick={() => {
        onAnnotate?.(!annotating);
      }}
    />
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
 * One component for the rows that draw it, because the label is the whole of
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
 * Where a control's caption sits: standing on the pill's top edge, with only
 * its beak crossing into the pill to point at the control below.
 *
 * The caption starts out centred on the control (see {@link PillButton}), so
 * the lift is its own half height, which puts its bottom edge on the control's
 * centre, plus half the pill's `h-11` row to carry that edge up to the row's
 * top. 22px is the one number the caption and the row share, and it holds at
 * every avatar size: the whole surface is drawn scaled, so both are in the
 * same units.
 *
 * Not further up. Growing downward the canvas keeps only its own pad above the
 * pill, which a caption standing here clears by around 7px, and one lifted
 * clear of the pill's edge would be cut off by the top of the window.
 */
const CONTROL_CAPTION_LIFT = "-translate-y-[calc(50%+22px)]";

/**
 * A control in the pill.
 *
 * `label` is always the accessible name. It is drawn in the row only when the
 * pill has room for words (`showLabel`); everywhere else the control is an
 * icon with its name in a {@link Caption} above it, the way the Dock names an
 * icon under the pointer, so the call's controls are icon-only without being
 * unlabelled and the pill is one width whatever the pointer is doing.
 *
 * **The caption is `:hover`, deliberately, and this is the one place on the
 * surface where that is not a matter of taste.** The host's window is
 * click-through, so the page derives its own hover by hit-testing coordinates
 * against the pill on every forwarded mouse-move rather than trusting
 * `mouseenter` (`companion-surface-page.tsx`). A per-control reveal driven off
 * React's mouse events would be betting on the events that page does not
 * receive. The held-down background on this very button runs on `:hover`, so
 * a caption on the same mechanism works exactly where the rest of the control
 * does.
 *
 * **The caption escapes the row's clipping by having a different containing
 * block.** The row hides its overflow so nothing is drawn past the pill while
 * the width catches up with the content, and a caption standing above the row
 * is exactly that overflow. Overflow clips only what the clipping box
 * contains, so the caption is positioned against the row's parent instead:
 * this button is not positioned and neither is the row, and with no offsets
 * of its own the caption takes its static position, which for the child of a
 * flex container is where it would sit as the sole item. `justify-center` and
 * `items-center` put that on the control's centre, and from there the caption
 * lifts by {@link CONTROL_CAPTION_LIFT}. Nothing measures anything.
 *
 * `pressed` is the control's own on or off, which is a state: a button
 * reporting a state it does not have is one assistive technology describes
 * wrongly, so it is undefined for everything that does not toggle, which is
 * most of this surface. Where it is set it draws the held-down look as well,
 * so the state a looking user reads off the background and the state a reader
 * is told cannot come apart.
 */
function PillButton({
  icon,
  label,
  tone,
  showLabel = false,
  pressed,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tone?: "positive" | "negative";
  showLabel?: boolean;
  pressed?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      // A press on a control is not the start of a drag. Without this the
      // surface would move under a click meant to activate something on it.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      className={`group flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-[12px] transition-colors hover:bg-white/15 ${
        pressed === true ? "bg-white/15" : ""
      } ${
        tone === "negative"
          ? "text-[#ff6b6b]"
          : tone === "positive"
            ? "text-[#5ee08a]"
            : "text-white/85"
      }`}
    >
      {icon}
      {showLabel ? (
        <span>{label}</span>
      ) : (
        // `data-label` is the caption's contract, and it is here because the
        // behaviour itself is a stylesheet: a test running without Tailwind
        // sees a span either way, so the attribute is the only honest way to
        // hold that this word is hidden until the pointer arrives.
        <Caption
          label={label}
          className={`opacity-0 group-hover:opacity-100 ${CONTROL_CAPTION_LIFT}`}
          data-label="hover"
        />
      )}
    </button>
  );
}
