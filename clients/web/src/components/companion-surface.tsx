import { AudioLines, ScrollText, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  COMPANION_PERCH_HOP,
} from "@vellumai/ipc-contract";
import type {
  CompanionAnnotationTool,
  CompanionCharacter,
  CompanionPicker,
  CompanionWatchRetro,
  VoiceActivityControlAction,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import {
  CALL_CONTROLS_WIDTH,
  CALL_LINE_WIDTH,
  FALLBACK_COLUMN,
  NAME_CAPTION_LIFT,
  CallBody,
  Caption,
  CaptionSideContext,
  PillButton,
  StopWatchingButton,
} from "@/components/companion-call-controls";
import type {
  CompanionCallShortcuts,
  CompanionSurfaceSpotlight,
} from "@/components/companion-call-controls";
import { CompanionCallWorkShelf } from "@/components/companion-call-work";
import { unplacedOfferLabelKey } from "@/components/companion-dictation-offer";
import { CompanionPeek } from "@/components/companion-peek";
import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The macOS companion surface (LUM-3086): the assistant's avatar floating from
 * app launch, with a pill carrying the ways to reach it unfurling around it,
 * and unfurling the same way while a call runs.
 *
 * **Two layers, and the mascot is the fixed point.** The creature is drawn
 * above the pill so it can bob, perch on a control, or walk into an intro card
 * without being clipped. In the ordinary layout the pill reserves its leading
 * slot for that creature and unfurls from the slot's far edge. The avatar holds
 * one point in the canvas in every non-call state, which is the point the host
 * positions this window around, so the surface reads as one object changing
 * shape rather than a series of different objects and the eye and cursor keep
 * the same target.
 *
 * **Two sizes, and the creature carries the difference.** The host publishes a
 * box for the avatar and a box for the pill, and the page around this scales
 * the whole canvas by the second, so every length below is stated once at the
 * size the layout is authored at. The creature is scaled again inside that by
 * the ratio between the two boxes, and the handful of distances measured from
 * its edge (the gap, the near edge, its own half box) are worked out from the
 * contract's helpers and divided back into these units.
 *
 * **Growth needs clearance on the side it runs into** for a pill as wide as
 * `COMPANION_BASE_MAX_PILL_WIDTH`, which is the host's ceiling. A circle parked
 * against the right edge does not have it, and unclamped
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

/**
 * Which edge of the display a call's bar rests on. See `CompanionDock`.
 *
 * `bottom` and `top` keep the bar the row it is everywhere else; `left` and
 * `right` stand it up as a column under the creature, since a row lying
 * against a side edge would reach into the middle of the screen. The host
 * decides, for the same reason it decides the growths: the edge is a fact
 * about where the window was put, and the canvas a column needs is one the
 * host has to have built.
 */
export type CompanionSurfaceDock = "bottom" | "top" | "left" | "right";

export type {
  CompanionCallShortcuts,
  CompanionSurfaceSpotlight,
} from "@/components/companion-call-controls";

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
 * The shape is a lit line in the assistant's colour with nothing inside it.
 * The edge is what makes it findable on a busy desktop, where a small block of
 * colour is not, and being hollow is what keeps it from taking the screen away
 * from whatever the user is actually working in.
 *
 * **Two sizes, because the shape gives way to the creature.** `idle` is the
 * marker: the creature is tucked behind it and peeks out of it every few
 * seconds. `closing` is where it ends when a hand arrives and the creature
 * stands up, which is on the creature's own artwork: the marker draws in from
 * both ends until it is a ring the size of the creature, and goes out as the
 * creature reaches full size. One gesture, and the thing it hands the surface
 * over to is the creature.
 *
 * **Inward, not outward.** The pill used to grow into a frame the creature
 * stood inside. The marker is wide and the creature is not, so that read as
 * the surface swelling under the pointer and then the creature appearing in
 * the middle of it, which is two events; drawing in reads as one shape
 * becoming the other. It also leaves nothing lit behind the standing creature,
 * which is the state hover is actually for.
 *
 * **Only `closing` scales with the creature**, because it lands on it. `idle`
 * holds one size on every setting: sizing the creature is a statement about
 * the creature, and someone who wants a big mascot when they look at it has
 * not asked for a big lozenge sitting over their work all day. The rim holds
 * one thickness for the same reason, so the line stays a line instead of
 * thickening into a frame.
 */
const RESTING_PILL = {
  /** The marker. Wider than the artwork it stands in for, and hollow. */
  idle: { width: 64, height: 14 },
  /**
   * Where the line ends up: the creature's own artwork, squared, so a
   * `rounded-full` shape drawn at it is a ring on the creature's edge. Scaled
   * with the creature by the caller, since the creature is what it lands on.
   */
  closing: AVATAR_IMAGE,
  /** The lit line's thickness, at every size and every setting. */
  rim: 2,
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
  // the dial stands fewer controls in the same row. The
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
   * Which edge of the display the call's bar rests on. See
   * {@link CompanionSurfaceDock}. Read only on a call: every other pill stays
   * horizontal whatever the host remembers.
   */
  dock?: CompanionSurfaceDock;
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
   * separately from it: the avatar is visually inside the pill but remains a
   * sibling layer so its bob and intro choreography are not clipped. The host
   * therefore hit-tests both elements.
   */
  avatarRef?: Ref<HTMLDivElement>;
  /**
   * Begin a drag. Everything drawn that is not a control is a handle, so this
   * is wired to the avatar and to the pill, and the controls stop the press
   * from reaching it.
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
  spotlight?: CompanionSurfaceSpotlight;
  /**
   * Call the creature out of its own spot and into whatever the caller has
   * marked with `data-avatar-stage` inside {@link CompanionSurfaceProps.intro}.
   *
   * The introduction's card uses it to hold the creature in its middle while it
   * says "click me": the sentence and the thing it names then occupy one place,
   * and nothing on the card has to explain where to look. The marker at home
   * goes out while it is away, since a lit spot the creature has just left
   * reads as a second creature.
   */
  avatarStaged?: boolean;
  /**
   * Keep the creature tucked behind the resting marker even while the
   * introduction's card is on screen.
   *
   * The run opens on what the user is actually looking at: the lit sliver, with
   * the creature still inside it. Every other beat needs the creature drawn
   * (a card pointing at an empty marker is the one thing this must not do), so
   * the card being up is normally enough to bring it out; this is the one beat
   * that wants the surface exactly as it found it, and a hover still brings the
   * creature out for real while the card says so.
   */
  avatarTucked?: boolean;
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
   * What a press on that frame draws, which the strip Draw opens shows held
   * down. Main's the way {@link CompanionSurfaceProps.annotating} is, and
   * read the same way: the pill chooses, and this is what main did with it.
   *
   * Absent is a shell that names no tool, which is a shell with only the
   * pencil, and then no strip is drawn: a strip offering shapes to a shell
   * that cannot take the choice would draw the pencil held down whatever
   * was pressed.
   */
  annotationTool?: CompanionAnnotationTool;
  /** A press on the strip: the tool the user reached for. */
  onAnnotationTool?: (tool: CompanionAnnotationTool) => void;
  /**
   * The strip of drawing tools, handed out for the reason
   * {@link CompanionSurfaceProps.rootRef} is: it stands off the pill, above
   * or below it, and the host hit-tests a union of rects, so a strip it is
   * not told about is one whose presses fall through to the desktop.
   */
  drawToolsRef?: Ref<HTMLDivElement>;
  /**
   * The press of Draw, carrying the state it is asking for rather than being
   * a toggle. The mode is the shell's and the shell may refuse it (a share
   * that has ended takes it down), so the press says what it wants and the
   * pushed state says what happened.
   */
  onAnnotate?: (annotating: boolean) => void;
  /**
   * Whether anything is on the shared surface to take down: the assistant's
   * marks, or the mode the user's own ink is drawn under. Draws Clear beside
   * Draw for as long as it is.
   *
   * Absent rather than disabled when nothing is, for the reason Draw is
   * absent off a share: a control with nothing to be about. The host says,
   * since the marks are on a window this surface cannot see.
   */
  marked?: boolean;
  /**
   * The press of Clear: take down everything on the shared surface and leave
   * the share running. Main's, the way Draw's press is: it holds the marks
   * and opened the frame the ink is on, and the pushed state says what
   * happened.
   */
  onClearMarks?: () => void;
  /**
   * The picker the popover is showing, if it is one the call bar opened, so
   * its chevron reads as held open.
   */
  openPicker?: CompanionPicker;
  /** A chevron pressed: open that picker in the popover, or close it. */
  onPicker?: (picker: CompanionPicker) => void;
  /**
   * The keys the call row's controls also answer to, as the caption spells
   * them (`⌥S`). Absent where the host watches no chord, so the caption never
   * names a key that does nothing. The share and the pen are shown their key
   * only while the row offers Share at all, since that is the answer the
   * binding is armed on too.
   */
  shortcuts?: CompanionCallShortcuts;
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
   * The short form of what the assistant needs from the user, carried by a
   * call's bar as a row of its own. Composed by the caller for the reason the
   * offer's card is. Drawn only on a call whose bar is a row.
   */
  prompt?: ReactNode;
  /** The prompt row's element, for the host to hit-test the pointer against. */
  promptRef?: Ref<HTMLDivElement>;
  /**
   * How many prompts the user put off, counted on the call's row so they can
   * be reviewed. Zero draws nothing.
   */
  promptsDeferred?: number;
  onReviewPrompts?: () => void;
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
  /**
   * Told when the list of the call's work opens or closes on the bar. The
   * host hit-tests the pointer against the joined row, and a list that closes
   * on its own (the work ran out) under a still pointer leaves nothing there
   * to move off; the host gives the desktop back on this.
   */
  onWorkShelfChange?: (shown: boolean) => void;
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
  dock = "bottom",
  rootRef,
  restingPillRef,
  avatarRef,
  onSurfacePointerDown,
  onSurfaceContextMenu,
  spotlight,
  avatarStaged = false,
  avatarTucked = false,
  onWatch,
  onTeach,
  picking = false,
  sharing = false,
  shareEnabled = false,
  sharePicking = false,
  onShare,
  onStopShare,
  annotating = false,
  annotationTool,
  onAnnotationTool,
  drawToolsRef,
  onAnnotate,
  marked = false,
  onClearMarks,
  openPicker,
  onPicker,
  shortcuts,
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
  prompt: hostPrompt,
  promptRef,
  promptsDeferred = 0,
  onReviewPrompts,
  onWorkShelfChange,
}: CompanionSurfaceProps) {
  const { t } = useTranslation();
  /**
   * Whether the list of the call's work is open on the bar. The surface's own
   * state rather than the host's: it is a view of what the call already
   * carries, opened and closed from the bar, and nothing outside the bar acts
   * on it. Closed when the work runs out, so the next piece of work arrives
   * as a count rather than reopening a list the user closed long ago.
   */
  const work = phase === "call" ? call?.work : undefined;
  const hasWork = work !== undefined && work.length > 0;
  const [workShelfOpen, setWorkShelfOpen] = useState(false);
  useEffect(() => {
    if (!hasWork) {
      setWorkShelfOpen(false);
    }
  }, [hasWork]);
  /**
   * What stands joined to the bar: the host's prompt, which is waiting on the
   * user and so always outranks it, or else the call's work while its list is
   * open.
   */
  /**
   * The host's prompt, which only a row carries: a column has no edge for a
   * list of answers, and the host draws those in a window of their own there.
   * The call's own list stands beside a column instead.
   */
  const sideDocked = dock === "left" || dock === "right";
  const rowPrompt = sideDocked ? undefined : hostPrompt;
  const workShelfShown =
    rowPrompt === null || rowPrompt === undefined
      ? workShelfOpen && hasWork
      : false;
  useEffect(() => {
    onWorkShelfChange?.(workShelfShown);
  }, [onWorkShelfChange, workShelfShown]);
  const prompt = useMemo(
    () =>
      rowPrompt ??
      (workShelfOpen && hasWork ? (
        <CompanionCallWorkShelf work={work} accentHex={accentHex} />
      ) : undefined),
    [rowPrompt, workShelfOpen, hasWork, work, accentHex],
  );
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
   * Where the creature stands while a beat of the introduction is about one
   * control: over that control, rather than on its own spot.
   *
   * Measured from the control's own element, because which controls the bar
   * carries depends on the session's state, so their positions are not
   * something this component can derive from the two boxes it is drawn at. The
   * measurement is repeated across the pill's 300ms width animation and then
   * left alone, so a beat that arrives while the bar is still unfurling ends
   * up over the right control rather than over where it used to be.
   */
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [perch, setPerch] = useState<number | null>(null);
  const perchFor = spotlight === "talk" ? undefined : spotlight;
  useEffect(() => {
    if (perchFor === undefined) {
      setPerch(null);
      return;
    }
    return trackInBox(boxRef, `[data-control="${perchFor}"]`, (point) => {
      setPerch(point.x);
    });
  }, [perchFor, phase, sharing]);

  /**
   * Where the creature is standing while it has been called into something
   * drawn beside it, which is the introduction's card asking to be clicked.
   *
   * **The creature goes to the sentence about it.** A card that says "click me"
   * beside a creature sitting somewhere else asks the reader to find the thing
   * first; the creature walking into the middle of the card puts the sentence
   * and the thing it names in one place, and what to press is then obvious
   * without a word about where it is.
   *
   * Measured from whatever the caller staged rather than derived, because the
   * card's own box is the card's business: it reserves the room and marks the
   * spot, and the surface only has to find the mark. Repeated across the
   * card's arrival, so a creature called while the card is still landing ends
   * up in the middle of where it landed.
   */
  const [stage, setStage] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!avatarStaged) {
      setStage(null);
      return;
    }
    return trackInBox(boxRef, "[data-avatar-stage]", setStage);
  }, [avatarStaged, phase]);

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
  // Never while the introduction is up (`intro` is the card itself): that card
  // names whatever the beat is about, in more words and with the reason
  // attached, and this label under it would be the same word again with a card
  // held 20 units off the creature to make room for it.
  // Never while the introduction is up (`intro` is its card): that card names
  // whatever the beat is about, in more words and with the reason attached, and
  // this label under it would be the same word again with a card held clear of
  // it. `spotlight` still forces it for the demo reel, which has no pointer in
  // the room and no card either.
  const named =
    intro === null || intro === undefined
      ? spotlight === "talk" || (phase === "hover" && dwelt)
      : false;
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
  const [contentSize, setContentSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  /**
   * The length the call's line was given past its own while the bar carries a
   * bigger prompt, as last drawn: across a row, or down a column. Taken back
   * out of every measurement, so the content is measured at its own size and
   * the bar never grows to fit a line that was only stretched to fill it.
   */
  const lineExtraRef = useRef({ width: 0, height: 0 });

  // The body is measured while it is still clipped, so the pill knows how wide
  // to grow before it starts growing. `scrollWidth` reports the content's own
  // width regardless of how little the collapsed pill is giving it, and
  // `scrollHeight` its height, which is the length of a column.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    const measure = () => {
      setContentSize({
        width: element.scrollWidth - lineExtraRef.current.width,
        height: element.scrollHeight - lineExtraRef.current.height,
      });
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
  const { scale, avatarRel, avatarHalf, gap, inUnits, lineAt, edgeAt } =
    companionLayoutFor(avatarBox, optionsBox);

  /**
   * Whether the pill is the call's bar.
   *
   * **The call is clearly not the pill, but a form of it.** The bar is centred
   * on the point the host put the window around, and the host takes the whole
   * thing to the display edge the way meeting controls sit. The creature keeps
   * the bar's leading slot, so the controls and the one on the call read as one
   * surface.
   */
  const inCall = phase === "call";

  /**
   * Whether the bar stands up as a column, which a call docked to a side of
   * the display does. See {@link CompanionSurfaceDock}.
   */
  const vertical = inCall && (dock === "left" || dock === "right");

  /**
   * Where the controls' captions go: over them on a row, and beside them on a
   * column, on the side facing the middle of the screen.
   */
  const captionSide: CaptionSide = !vertical
    ? "above"
    : dock === "left"
      ? "right"
      : "left";

  // The creature's leading slot, the body, and the trailing clearance. The
  // slot is one authored pill row wide and scales with the options setting;
  // the creature has its own scale on the layer above it.
  //
  // A column is measured both ways. Its length is its content's, as the row's
  // width is, and its width is its content's too: a column of icons is one
  // icon wide, and a decision with words on its controls is as wide as the
  // words.
  const width = !expanded
    ? 0
    : vertical
      ? (contentSize?.width ?? FALLBACK_COLUMN.width) + 2 * INNER_GAP
      : COMPANION_BASE_AVATAR_BOX +
        (contentSize?.width ?? FALLBACK_WIDTHS[phase]) +
        INNER_GAP;
  const height = !expanded
    ? 0
    : COMPANION_BASE_AVATAR_BOX +
      (contentSize?.height ?? FALLBACK_COLUMN.height) +
      INNER_GAP;

  /**
   * Whether the call's bar carries a prompt, joined to it as one shape: over
   * or under a row, beside a column.
   */
  const joined = inCall && prompt !== null && prompt !== undefined;
  const promptMeasureRef = useRef<HTMLDivElement | null>(null);
  const [promptSize, setPromptSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = promptMeasureRef.current;
    if (!joined || element === null) {
      return;
    }
    const measure = () => {
      // Its fractional width, rounded up, in the surface's own units: a
      // whole-point width rounded down leaves the row a fraction too narrow
      // for its words, and they wrap onto a second line they do not need.
      const rect = element.getBoundingClientRect();
      setPromptSize({
        width: Math.ceil(rect.width / scale),
        height: Math.ceil(rect.height / scale),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [joined, prompt, scale]);
  /**
   * The bar's width while it carries a prompt: as wide as the wider of the
   * two, so the prompt's words are never cut to fit the call's controls and
   * the two keep one edge.
   */
  const barWidth =
    joined && !vertical ? Math.max(width, promptSize.width) : width;
  /**
   * The column's length while a list stands beside it, for the same reason:
   * as long as the longer of the two, so the two keep one edge.
   */
  const barHeight =
    joined && vertical ? Math.max(height, promptSize.height) : height;
  /**
   * What the prompt widened the bar by, given to the call's line: the line
   * says more of what the session is doing, and the controls end at the
   * bar's far edge under the prompt's answers rather than short of it.
   */
  const lineExtra = vertical ? barHeight - height : barWidth - width;
  useLayoutEffect(() => {
    lineExtraRef.current = vertical
      ? { width: 0, height: lineExtra }
      : { width: lineExtra, height: 0 };
  }, [lineExtra, vertical]);

  /**
   * The line the creature stands on, as the CSS edge the surface is drawn
   * from.
   *
   * The host's canvas is not symmetric about the creature, so the line is
   * measured from the near edge (see `CompanionLayout.lineAt`). Except for a
   * call docked to a side: a column reaches as far below the creature as
   * above, so the host builds that canvas symmetric, and the creature stands
   * on its centre line.
   */
  const avatarLine = vertical ? "50%" : lineAt(cardGrowth, 0);

  // **The avatar never moves outside a call.** It holds one spot in the canvas,
  // which is the spot the host positions this window around, and the pill
  // starts half a row before it so the creature occupies the leading slot.
  // Growing from the pill's centre instead would slide the mascot to a
  // different x-position in every state, so the surface would read as a series
  // of different objects rather than one object changing shape, and the user's
  // eye and cursor would have no fixed target to aim at.
  //
  // Each direction pins the outside edge of the avatar slot half a pill row
  // across the centre. The body runs away from the slot while the creature the
  // host measures every drag, clamp and direction check against stays put.
  const placement = edgeAt(
    growth,
    growth === "left" ? optionsBox / 2 : -(optionsBox / 2),
  );

  /**
   * The creature's box over the one this file's lengths are authored for.
   *
   * The closing ring takes it, because it lands on the creature; the idle
   * marker and the rim do not. See {@link RESTING_PILL}.
   */
  const restingScale = avatarBox / COMPANION_BASE_AVATAR_BOX;

  /**
   * The lit line's box: the marker, or the ring it draws in to on the
   * creature's own edge as the creature stands up.
   *
   * Read off `creatureOut` rather than off `hovered`, so the one thing that
   * decides whether the creature is standing decides where the line goes. The
   * two are the same gesture: the marker becomes the creature.
   */
  const restingBox = creatureOut
    ? {
        width: RESTING_PILL.closing * restingScale,
        height: RESTING_PILL.closing * restingScale,
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
        width: barWidth,
        // A column has a length of its own; a row is one row tall.
        ...(vertical ? { height: barHeight } : {}),
        // **Centred on the creature's own point.** The bar takes the point
        // the creature holds everywhere else and stands on its centre line
        // rather than on its baseline, and the canvas is symmetric about
        // that point, so the host centring the canvas on the display centres
        // the bar.
        left: "50%",
        top: avatarLine,
        transform: "translate(-50%, -50%)",
        transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
      }
    : {
        width,
        ...placement,
        // The pill and creature share a centre line, which seats the artwork in
        // the leading slot while its larger transparent box keeps room for the
        // bob and glow. Which canvas edge that line is measured from is the
        // host's call (see `CompanionSurfaceCardGrowth`).
        top: avatarLine,
        transform: "translateY(-50%)",
        // Settles rather than overshoots. A surface on screen all day should
        // not bounce every time the pointer crosses it.
        transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
      };

  /**
   * Where the creature is drawn: on the point the host put the window around,
   * or, on a call, in the bar's leading slot.
   *
   * The bar is centred on that point and its width is known here, so the
   * creature sits half a row in from its leading edge. The creature slides as
   * the bar unfurls and back as it collapses, over the pill's own duration, so
   * the two read as one object changing shape.
   */
  const creatureLeft =
    stage !== null
      ? `${stage.x}px`
      : perch !== null && !vertical
        ? `${perch}px`
        : inCall && !vertical
          ? `calc(50% - ${barWidth / 2 - COMPANION_BASE_AVATAR_BOX / 2}px)`
          : "50%";
  /**
   * The same step, read down the column: on a side dock the creature occupies
   * the column's first row, and the column is centred on the host's point.
   */
  const creatureTop =
    stage !== null
      ? // Both halves of a staged point, unlike a perch: the creature has been
        // called into the middle of something rather than onto the top of it.
        `${stage.y}px`
      : perch !== null && !vertical
        ? // Standing on the bar's own top edge, a gap and its own half box up,
          // which is the same step the pill takes off the creature everywhere
          // else read the other way round, and then the hop that clears the
          // bar itself.
          `calc(${avatarLine} - ${inUnits(avatarHalf + gap) + COMPANION_PERCH_HOP}px)`
        : vertical
          ? `calc(50% - ${barHeight / 2 - COMPANION_BASE_AVATAR_BOX / 2}px)`
          : avatarLine;

  return (
    // The box the whole surface is drawn in: the canvas divided by the options
    // scale, blown back up about its top-left corner, so every authored length
    // inside resolves in base units and the host never holds a second set of
    // dimensions.
    //
    // The pill, the creature and the introduction's card are sibling layers
    // inside it. The creature is visually inside the pill's leading slot, but
    // remains a sibling so its perch and card animations are not clipped by the
    // pill's own box.
    <div
      ref={boxRef}
      className="absolute top-0 left-0 origin-top-left"
      style={{
        width: `${100 / scale}%`,
        height: `${100 / scale}%`,
        transform: `scale(${scale})`,
      }}
    >
      {joined ? (
        <PromptShelf
          dock={dock}
          top={avatarLine}
          width={vertical ? promptSize.width : barWidth}
          height={barHeight}
          barThickness={vertical ? width : 44}
          promptRef={promptRef}
        >
          {prompt}
        </PromptShelf>
      ) : null}
      {joined ? (
        // The prompt at its own width, out of sight, so the bar can be made
        // wide enough for it. `inert` keeps its copies of the buttons out of
        // the tab order and the accessibility tree.
        <div
          ref={promptMeasureRef}
          inert
          aria-hidden
          data-theme="dark"
          className={`pointer-events-none invisible absolute top-0 left-0 w-max ${
            // Beside a column the list has the room the canvas keeps for the
            // capture picker, which stands on the same side.
            vertical ? "max-w-[400px]" : "max-w-[640px]"
          }`}
        >
          {prompt}
        </div>
      ) : null}
      {/* The pill is a drag handle, as the avatar is. Controls opt out by
        stopping the press, so everything on it that is not a button can be
        grabbed. */}
      <div
        // One row in a box whose width animates, so the row is pinned to the
        // pill's avatar-slot edge. `growth: "left"` anchors the pill by its
        // right, and a row left-aligned in a box narrower than itself spills
        // past that edge toward the avatar slot every time the width lags the
        // content: through the unfurl and instantly on each label reveal.
        className={`absolute flex cursor-grab items-center rounded-full duration-300 select-none active:cursor-grabbing ${
          vertical
            ? "flex-col transition-[width,height] will-change-[width,height]"
            : "h-11 transition-[width] will-change-[width]"
        } ${!inCall && growth === "left" ? "justify-end" : ""}`}
        style={style}
        onPointerDown={onSurfacePointerDown}
        onContextMenu={onSurfaceContextMenu}
        ref={rootRef}
      >
        {/* The pill's body, which exists only once there is a pill. At rest it
          is transparent, and fading it in as the width grows makes the pill
          unfurl from the avatar slot rather than appear at full width. */}
        <span
          className={`absolute inset-0 rounded-full transition-opacity duration-200 ${
            // Joined to the prompt row it is one shape with it: opaque, so
            // the row's own ground does not show through, and with no edge or
            // shadow of its own across the join.
            joined
              ? "bg-[#17181b]"
              : "border border-white/10 bg-[#17181b]/95 shadow-lg shadow-black/40"
          }`}
          style={{ opacity: expanded ? 1 : 0 }}
          aria-hidden
        />
        {/* The pill's one in-flow row. Its avatar-facing end reserves a whole
          row for the creature, and the far end keeps the ordinary clearance.
          On the row rather than on the pill, so the pill's own box goes to
          nothing at rest while the body inside it keeps being measured. */}
        <div
          className={`relative flex shrink-0 items-center ${
            vertical ? "flex-col" : "h-11"
          }`}
          // A column reserves its first row for the creature. A horizontal pill
          // reserves the slot on whichever end faces the fixed avatar point.
          style={
            vertical
              ? {
                  paddingTop: COMPANION_BASE_AVATAR_BOX,
                  paddingBottom: INNER_GAP,
                  paddingInline: INNER_GAP,
                }
              : growth === "left"
                ? {
                    paddingLeft: INNER_GAP,
                    paddingRight: COMPANION_BASE_AVATAR_BOX,
                  }
                : {
                    paddingLeft: COMPANION_BASE_AVATAR_BOX,
                    paddingRight: INNER_GAP,
                  }
          }
        >
          <div
            // Not positioned, on purpose: the controls' captions stand above
            // this row and would be clipped by it, and an absolute box escapes
            // its ancestors' clipping only while its containing block is
            // outside them. See `PillButton`.
            className={`flex items-center gap-1 overflow-hidden transition-opacity duration-200 ${
              vertical ? "min-h-0 flex-col" : "min-w-0"
            }`}
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
              <CaptionSideContext.Provider value={captionSide}>
                <CallBody
                  call={call}
                  assistantName={assistantName}
                  spotlight={spotlight}
                  watching={watching}
                  watchEnabled={watchEnabled}
                  picking={picking}
                  sharing={sharing}
                  shareEnabled={shareEnabled}
                  sharePicking={sharePicking}
                  annotating={annotating}
                  marked={marked}
                  annotationTool={annotationTool}
                  vertical={vertical}
                  drawToolsPlacement={
                    vertical
                      ? dock === "left"
                        ? "right"
                        : "left"
                      : cardGrowth === "up"
                        ? "above"
                        : "below"
                  }
                  drawToolsRef={drawToolsRef}
                  onAnnotationTool={onAnnotationTool}
                  onControl={onControl}
                  onWatch={onWatch}
                  onTeach={onTeach}
                  onShare={onShare}
                  onStopShare={onStopShare}
                  onAnnotate={onAnnotate}
                  onClearMarks={onClearMarks}
                  openPicker={openPicker}
                  onPicker={onPicker}
                  pickerSide={
                    vertical
                      ? dock === "left"
                        ? "right"
                        : "left"
                      : dock === "top"
                        ? "below"
                        : "above"
                  }
                  shortcuts={shortcuts}
                  promptsDeferred={promptsDeferred}
                  lineExtra={lineExtra}
                  onReviewPrompts={onReviewPrompts}
                  accentHex={accentHex}
                  workShelfOpen={workShelfShown}
                  onToggleWorkShelf={() => {
                    setWorkShelfOpen((open) => !open);
                  }}
                />
              </CaptionSideContext.Provider>
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
        it until a pointer arrives, then drawn in onto the creature and out.
        See {@link RESTING_PILL}.

        A sibling of the pill that carries content rather than the same
        element, and the two cross-fade. They are different shapes in different
        places: this one is centred on the creature the way the call's bar is,
        and every pill with something in it hangs off the creature's side. One
        element animating between the two would have to jump its anchor from
        the centre to an edge mid-transition, which reads as the surface
        flinching.

        **The footprint and the line are two nodes, and only the line moves.**
        This one is the marker's own box and never changes size, because it is
        what the pointer is hit-tested against: a shape that drew in from under
        the hand that arrived would take the surface out from under it, the
        pointer would land on the desktop, the creature would tuck back, and
        the marker would return under the same stationary pointer to start
        again. So the reach stays the marker's for as long as the creature is
        out, and staying anywhere the marker covered keeps it out.

        A drag handle, as the creature and the pill both are. It is the largest
        thing on screen at rest, so it is what a hand reaches for to move the
        surface, and a shape that ignored the press would read as broken.
        `aria-hidden` because it says nothing the creature beside it does not
        already say: the creature carries the accessible name and the press. */}
      <div
        className="absolute cursor-grab active:cursor-grabbing"
        style={{
          width: inUnits(RESTING_PILL.idle.width),
          height: inUnits(RESTING_PILL.idle.height),
          // **The reach is not the drawing.** This box outlives the line
          // inside it, and it is drawn after the pill that carries content and
          // centred on the same point the call's bar stands on, so a live call
          // would hand its presses to an invisible sheet instead of to mute
          // and end. It takes the pointer only while the creature is in it.
          pointerEvents: creatureOut ? "none" : undefined,
          // Centred on the point the host put the window around, which is the
          // point the creature holds. The creature is a sibling drawn on that
          // same point, so centring the pill on it is what puts the creature
          // in the middle of the pill without either one being laid out in
          // terms of the other.
          left: "50%",
          top: avatarLine,
          transform: "translate(-50%, -50%)",
        }}
        onPointerDown={onSurfacePointerDown}
        onContextMenu={onSurfaceContextMenu}
        ref={restingPillRef}
        aria-hidden
      >
        {/* The lit line itself, centred in that footprint: the marker at rest,
          and the ring on the creature's own edge once the creature is out.
          Drawn in rather than grown, so the marker reads as becoming the
          creature rather than as swelling around it. */}
        <div
          className="absolute top-1/2 left-1/2 rounded-full transition-[width,height,opacity] duration-300"
          style={{
            width: inUnits(restingBox.width),
            height: inUnits(restingBox.height),
            transform: "translate(-50%, -50%)",
            transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
            // A reader who asked for stillness keeps the fade and loses the
            // draw-in: the line travelling in across the screen is the thing
            // they asked not to have.
            transitionProperty: reduce ? "opacity" : undefined,
            boxShadow: restingRim(
              accentHex,
              inUnits(RESTING_PILL.rim),
              inUnits(RESTING_PILL.bloom),
            ),
            // Gone the moment the creature is out, which is what the draw-in
            // hands the surface over to. Not unmounted: the fade is what makes
            // the two read as one surface changing shape rather than one
            // object replacing another.
            //
            // Gone too while the creature has been called away into the card,
            // and on every beat of the introduction after the first: this
            // marker is the creature's resting place, and left lit behind a
            // creature that is standing up, or visibly somewhere else, it reads
            // as a second object rather than as the place the first one sleeps.
            opacity:
              creatureOut || stage !== null || (introDrawn && !avatarTucked)
                ? 0
                : 1,
          }}
        />
      </div>
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
          top: avatarLine,
          // Pulled up by the avatar's own half-box (a true point value, so it
          // goes through `inUnits` the way `edgeAt`/`lineAt` do) plus a few
          // flat pixels in the caption's own authored scale: enough that the
          // beak lands on the avatar's edge rather than short of it.
          transform: `translate(-50%, calc(-100% - ${inUnits(avatarHalf)}px - ${NAME_CAPTION_LIFT}px))`,
        }}
        label={t("companionSurface.talk")}
      />
      {/* Drawn after the pill so the creature sits above its leading slot and
        can leave that slot for an intro beat without being clipped. */}
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
        collapsed={!creatureOut && (!introDrawn || avatarTucked)}
        // The peek rides the marker, which is drawn at one size on every
        // setting, so it counters what this node carries. That is the avatar's
        // box over the authored one: the options scale on the box above
        // cancels against `avatarRel`.
        restingScale={COMPANION_BASE_AVATAR_BOX / avatarBox}
        style={{
          left: creatureLeft,
          top: creatureTop,
          // Over the card rather than under it while it is standing in the
          // card's middle. The card is drawn after the creature, so that they
          // are siblings is not enough: without this the creature flies behind
          // the very panel that asked it over.
          zIndex: stage === null ? undefined : 2,
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
            : perch === null && stage === null
              ? "left 300ms cubic-bezier(.2,.8,.2,1), top 300ms cubic-bezier(.2,.8,.2,1)"
              : // Being called somewhere the introduction is pointing, which
                // overshoots and settles: the creature hops onto the control,
                // or up into the card, rather than sliding to a halt there. A
                // call's own glide keeps its easing above, where the creature
                // and the bar are one shape moving and an overshoot would pull
                // them apart.
                "left 420ms cubic-bezier(.34,1.56,.64,1), top 420ms cubic-bezier(.34,1.56,.64,1)",
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
 * Follow the centre of the first element matching `selector` inside `box`, in
 * the units that box's contents are authored in, for as long as it might still
 * be moving.
 *
 * **Measured, not derived.** What the creature is called to are things whose
 * position this component cannot work out: which controls a call's bar carries
 * depends on the session, and where a card's middle is depends on the card. So
 * the caller marks the spot in its own markup and this finds it.
 *
 * Repeated across the pill's 300ms width animation and the card's arrival and
 * then left alone: a creature called while either is still moving ends up where
 * the thing settled rather than where it was when the call came.
 *
 * Client rects are in screen pixels and the box is drawn scaled, so the offset
 * is divided back into the units everything inside it is stated in.
 */
const trackInBox = (
  box: { current: HTMLElement | null },
  selector: string,
  onPoint: (point: { x: number; y: number }) => void,
): (() => void) => {
  let frame = 0;
  const startedAt = performance.now();
  const measure = (): void => {
    const root = box.current;
    // Searched from the box rather than from the pill, which the host owns the
    // ref to: what is being looked for is inside this box either way, and one
    // element cannot carry two refs without the merge being written out by
    // hand on every render.
    const target = root?.querySelector<HTMLElement>(selector);
    if (root && target) {
      const rootBox = root.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      const scaleNow =
        rootBox.width === 0 ? 1 : root.offsetWidth / rootBox.width;
      onPoint({
        x: (targetBox.left + targetBox.width / 2 - rootBox.left) * scaleNow,
        y: (targetBox.top + targetBox.height / 2 - rootBox.top) * scaleNow,
      });
    }
    if (performance.now() - startedAt < 500) {
      frame = requestAnimationFrame(measure);
    }
  };
  measure();
  return () => {
    cancelAnimationFrame(frame);
  };
};

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
        so what hides the rest of the creature is the clip and never a fill.

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
      {/* The creature standing up out of the marker. A wrapper of its own
        because the scale is a `transform` and the bob below already owns
        one. */}
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
 * that nothing in front would take them, or that the paste failed. The words and the answers are on
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
          : t(unplacedOfferLabelKey(offer.reason))}
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
 * The prompt row a call's bar carries, joined to the bar as one shape.
 *
 * Drawn behind the bar, from the bar's centre line out to the far side of the
 * row, so the bar's round ends close the shape on the near side and the bar
 * itself never moves: the creature and every control stay where the call put
 * them. Above the bar on the bottom edge and below it on the top, the side
 * the card room is on. A hairline marks the join.
 */
function PromptShelf({
  dock,
  top,
  width,
  height,
  barThickness,
  promptRef,
  children,
}: {
  dock: CompanionSurfaceDock;
  top: string;
  /** Across a row, the bar's width; beside a column, the list's own. */
  width: number;
  /** The column's length, which the list beside it matches. */
  height: number;
  /** How thick the bar is across: a row's height, or a column's width. */
  barThickness: number;
  promptRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const half = barThickness / 2;
  // Which way the shelf stands off the bar: toward the middle of the screen.
  const side =
    dock === "top"
      ? "below"
      : dock === "left"
        ? "right"
        : dock === "right"
          ? "left"
          : "above";
  const across = side === "left" || side === "right";
  const placed: CSSProperties = across
    ? {
        // Beside the column: its own width plus the half of the column it
        // runs behind, as long as the column, and centred on the same line.
        left: "50%",
        top,
        width: width + half,
        height,
        transform:
          side === "right" ? "translate(0, -50%)" : "translate(-100%, -50%)",
        [side === "right" ? "paddingLeft" : "paddingRight"]: half,
      }
    : {
        left: "50%",
        top,
        width,
        transform:
          side === "below" ? "translate(-50%, 0)" : "translate(-50%, -100%)",
        // The half of the bar the shelf runs behind.
        [side === "below" ? "paddingTop" : "paddingBottom"]: half,
      };
  const rounded = {
    above: "rounded-t-[22px]",
    below: "rounded-b-[22px]",
    left: "rounded-l-[22px]",
    right: "rounded-r-[22px]",
  }[side];
  return (
    <div
      ref={promptRef}
      // The surface paints its own dark ground in every host theme, so the
      // design-library tokens the row is drawn with resolve against dark.
      data-theme="dark"
      data-shelf-side={side}
      className="absolute"
      style={placed}
      onPointerDown={(event) => {
        // A press here is an answer, not a grab of the surface.
        event.stopPropagation();
      }}
    >
      <span
        aria-hidden
        className={`absolute inset-0 bg-[#17181b] shadow-lg shadow-black/40 ${rounded}`}
      />
      <span
        aria-hidden
        className={`absolute bg-white/10 ${
          across ? "top-4 bottom-4 w-px" : "right-4 left-4 h-px"
        }`}
        style={{ [oppositeEdge[side]]: half }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/** The edge of the shelf that runs behind the bar, by the side it stands on. */
const oppositeEdge = {
  above: "bottom",
  below: "top",
  left: "right",
  right: "left",
} as const;
