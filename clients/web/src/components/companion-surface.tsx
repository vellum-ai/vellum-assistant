import {
  ArrowUp,
  AudioLines,
  Check,
  Eye,
  EyeOff,
  Keyboard,
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
  ReactNode,
  Ref,
} from "react";

import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_BASE_MAX_PILL_WIDTH,
} from "@vellumai/ipc-contract";
import type {
  CompanionCharacter,
  CompanionTurn,
  CompanionWatchRetro,
  VoiceActivityControlAction,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

import { MarkdownMessage } from "@vellumai/design-library";

import { openCompanionLink } from "@/runtime/companion-surface";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { companionLayoutFor } from "@/components/companion-layout";
import { useTranslation } from "@/i18n";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The macOS companion surface (LUM-3086): the assistant's avatar floating from
 * app launch, with a pill carrying the voice and type-chat options unfurling
 * beside it, and unfurling the same way while a call runs.
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
 * as wide as {@link COMPANION_BASE_MAX_PILL_WIDTH}, which is what the card
 * draws. A circle parked against the right edge does not have it, and unclamped
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
   * It ranks below `typing` and `call` and above `hover`: a half-typed
   * sentence and a live call are both something the user is in the middle of.
   * Being outranked costs the session nothing, because this phase is only what
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
  | "call"
  /**
   * Typing: the pill becomes a card carrying a condensed read of the
   * conversation and somewhere to answer it. The only phase that grows
   * vertically, which is why it is the only one that stops being a pill.
   */
  | "typing";

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
 * Which way the typing card unfurls out of the composer row, which holds the
 * line the pill occupied.
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
 */
const AVATAR_IMAGE = 28;

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
 * The two phases that never reach this are absent from it: `resting` has no
 * pill to measure, and `typing` states {@link CARD_WIDTH} rather than measuring
 * anything.
 */
export const FALLBACK_WIDTHS: Record<
  Exclude<CompanionSurfacePhase, "resting" | "typing">,
  number
> = {
  // Three icon-only controls, which is the row as it is first drawn: the labels
  // are revealed one at a time under the pointer, and on the first frame there
  // is no pointer on any of them yet.
  hover: 112,
  // The same row of controls hover draws, since the session is run from it
  // rather than from a row of its own, plus the one word the running session
  // pins open on the control holding it.
  watching: 151,
  // Two labelled controls, both drawn: this row is a question waiting on an
  // answer rather than a set of ways in, so its words are not the pointer's to
  // reveal. That is what makes it wider than the idle row it stands in for.
  summary: 220,
  // The row with the stop control on it, which is the widest a call draws: a
  // watch session adds a fifth control to the four the call already has.
  call: 288,
};

/**
 * The card is a fixed width, unlike the pills.
 *
 * A pill is as wide as its controls and nothing more, so measuring is the only
 * honest answer. A card holds wrapped prose, and prose has no natural width:
 * measuring it would size the card to whatever the last turn happened to say
 * and reflow the whole surface on every message.
 */
const CARD_WIDTH = COMPANION_BASE_MAX_PILL_WIDTH;

/**
 * The tallest the conversation gets before it scrolls.
 *
 * The card is still a card, not a chat window: it holds a readable stretch of
 * the exchange and the rest is scrolled to, so a long reply can be read in
 * place without the surface growing until it runs off the top of the display.
 * Whatever this is, `COMPANION_BASE_CARD_HEIGHT` in the contract has to be
 * sized to hold it plus the composer row.
 */
const TURNS_MAX_HEIGHT = 220;

/**
 * One side of one exchange, condensed for the card.
 *
 * The contract's type rather than one of this component's own: the same rows
 * are published by the app's window and pushed through main to get here, and a
 * second declaration is how the two ends come to disagree about what a turn is.
 */
export type { CompanionTurn };

export interface CompanionSurfaceProps {
  phase: CompanionSurfacePhase;
  /**
   * The tail of the conversation, most recent last. Only the last couple are
   * drawn; the card is a glance, and the app is where the thread lives.
   */
  turns?: CompanionTurn[];
  /** The assistant's name, for the composer's placeholder. */
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
  onSurfaceMouseDown?: (event: ReactMouseEvent<HTMLDivElement>) => void;
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
   * in the room, where the difference between reaching for Talk and reaching
   * for Type is the whole point of the frame.
   */
  spotlight?: "talk" | "type";
  /**
   * Start a live-voice session. Absent leaves Talk inert, which is what
   * Storybook wants: there is no session to start there.
   */
  onTalk?: () => void;
  /**
   * Open the composer, which is what Type does. The caller owns the phase, so
   * this reports the press rather than switching to `typing` here: in the
   * Electron host the same press also has to lend the window the keyboard.
   */
  onType?: () => void;
  /**
   * Start or stop the session that reads the screen, which is what Watch does.
   *
   * One press for both edges, the way the contract's `toggleWatch` is: the
   * surface draws a single control, and the side holding the session is the
   * only one that knows which edge a press is.
   */
  onWatch?: () => void;
  /**
   * Send what was typed. The text is the composer's own until it leaves, so
   * this is the only thing the caller ever sees of it.
   */
  onSubmit?: (message: string) => void;
  /**
   * Close the composer without sending, which is what Escape asks for.
   */
  onCancelTyping?: () => void;
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
   * covers every turn that is not one: a message sent from the composer here,
   * and anything the user set going in the app before turning back to their own
   * work.
   */
  working?: boolean;
  /**
   * Whether a session reading the screen is running.
   *
   * Its own input rather than `phase === "watching"`, and this is the one place
   * on the surface where that separation is not a matter of taste. The phase
   * says what the pill is showing; this says whether the screen is being read,
   * and they are different questions. A phase is outranked by a half-typed
   * sentence and by a live call, so an indicator drawn from one would go dark
   * the moment the user typed or took a call, which is the same capture the
   * user cannot see with a different trigger. The ring belongs to the session,
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
   * outranked by a call and by a half-typed sentence, and a question the user
   * has been asked must not silently lose its answer because they picked up the
   * phone.
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
  turns = [],
  assistantName = "your assistant",
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
  onSurfaceMouseDown,
  onSurfaceContextMenu,
  spotlight,
  onTalk,
  onType,
  onWatch,
  onSubmit,
  onCancelTyping,
  onAvatarClick,
  working = false,
  watching = false,
  watchRetro,
  onWatchRetro,
  captureCount = 0,
  watchEnabled = false,
  call,
  onControl,
  intro,
}: CompanionSurfaceProps) {
  const expanded = phase !== "resting";
  const typing = phase === "typing";
  /**
   * Whether the summary of a finished session is still being written.
   *
   * Drawn as the session's own ring rather than the assistant's, because it is
   * the same session finishing rather than an unrelated turn: the user pressed
   * stop and the light is still on for what they narrated. Reads off the input
   * rather than the phase, since a call or an open composer outranks the phase
   * and the work goes on regardless.
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
  const width = typing
    ? CARD_WIDTH
    : !expanded
      ? 0
      : (contentWidth ?? FALLBACK_WIDTHS[phase]) + 2 * INNER_GAP;

  // The distances everything below is placed by, in points, and the one
  // conversion into the units this layout is stated in. Shared with
  // `CompanionIntro`, whose card hangs off the same creature.
  const { scale, avatarRel, avatarHalf, gap, lineAt, edgeAt } =
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

  // The card growing downward draws its composer row first, so the row starts
  // on the avatar's top line and the card falls away from it; everything else
  // hangs upward off the avatar's bottom line.
  const dropsFromTheRow = typing && cardGrowth === "down";

  const style: CSSProperties = {
    width,
    ...placement,
    // **Bottom-flush with the avatar.** The pill's bottom edge sits on the
    // avatar's, and the card keeps that line: its composer row is the column's
    // last child growing up and its first growing down, so the row's bottom is
    // the avatar's bottom either way and the mascot does not move when Type is
    // pressed. The line is the avatar's *box*, not the artwork inside it, which
    // is inset by an `INNER_GAP` on every side and so stops short of it. Which
    // way the card stacks is the host's call: parked by the Dock a card growing
    // down would grow off the bottom of the screen, and at the top of the
    // display a card growing up has nowhere to be (see
    // `CompanionSurfaceCardGrowth`). The row is one options box tall, so a card
    // growing downward starts exactly that far above the line.
    top: lineAt(
      cardGrowth,
      dropsFromTheRow ? avatarHalf - optionsBox : avatarHalf,
    ),
    transform: dropsFromTheRow ? "none" : "translateY(-100%)",
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
        className={`absolute cursor-grab transition-[width] duration-300 select-none will-change-[width] active:cursor-grabbing ${
          typing
            ? // The composer row is the column's last child, so a card growing
              // downward reverses the column: the row that holds the avatar's
              // line has to stay on that line, and the turns stack away from
              // it.
              `flex rounded-[22px] ${cardGrowth === "up" ? "flex-col" : "flex-col-reverse"}`
            : // One row in a box whose width animates, so the row is pinned to
              // the pill's avatar-facing edge. `growth: "left"` anchors the
              // pill by its right, and a row left-aligned in a box narrower
              // than itself spills past that edge, across the gap and over the
              // creature, every time the width lags the content: through the
              // unfurl and instantly on each label reveal.
              `flex h-11 items-center rounded-full ${growth === "left" ? "justify-end" : ""}`
        }`}
        style={style}
        onMouseDown={onSurfaceMouseDown}
        onContextMenu={onSurfaceContextMenu}
        ref={rootRef}
      >
        {/* The pill's body, which exists only once there is a pill. At rest
          there is nothing beside the avatar to draw, and fading the body in
          as the width grows is what makes the pill unfurl out of the gap
          rather than appear in it. */}
        <span
          className={`absolute inset-0 border border-white/10 bg-[#17181b]/95 shadow-lg shadow-black/40 transition-opacity duration-200 ${
            // Radius follows the same rule as the gap: the controls are 28pt
            // so their radius is 14, and 8pt of clearance puts the outer
            // radius at 22. A pill happens to reach that by being 44 tall;
            // the card has to say it.
            typing ? "rounded-[22px]" : "rounded-full"
          }`}
          style={{ opacity: expanded ? 1 : 0 }}
          aria-hidden
        />
        {typing && turns.length > 0 && <RecentTurns turns={turns} />}
        {/* The pill's one in-flow row, and where the clearance at either end
          lives. On the row rather than on the pill, so the pill's own box
          goes to nothing at rest while the body inside it keeps being
          measured. */}
        <div
          className="relative flex h-11 shrink-0 items-center"
          style={{ paddingInline: INNER_GAP }}
        >
          {typing ? (
            <Composer
              assistantName={assistantName}
              watching={watching}
              onSubmit={onSubmit}
              onCancel={onCancelTyping}
              onWatch={onWatch}
            />
          ) : (
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
                  watching={watching}
                  onControl={onControl}
                  onWatch={onWatch}
                />
              ) : phase === "summary" && watchRetro !== undefined ? (
                <SummaryBody retro={watchRetro} onWatchRetro={onWatchRetro} />
              ) : (
                <IdleBody
                  spotlight={spotlight}
                  watching={watching}
                  watchEnabled={watchEnabled}
                  onTalk={onTalk}
                  onType={onType}
                  onWatch={onWatch}
                />
              )}
            </div>
          )}
        </div>
      </div>
      {/* Drawn after the pill so the glow, which falls off well past the
        creature, lands over the pill's leading edge rather than under it. */}
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
        onMouseDown={onSurfaceMouseDown}
        onContextMenu={onSurfaceContextMenu}
        onClick={onAvatarClick}
      />
      {intro}
    </div>
  );
}

/**
 * The conversation, stacked above the composer.
 *
 * **Scrolled, not clipped.** An exchange the user has on this surface is one
 * they should be able to read on it, so the turns get a viewport of their own
 * and the older ones are scrolled back to rather than truncated. It is still
 * not a transcript: what crosses the bridge is a bounded tail (see the mirror's
 * `TAIL`), and the app is where the whole thread lives.
 *
 * **Pinned to the newest.** The view is anchored at the bottom on every change,
 * because the reason to look at this card is what just arrived, and a streaming
 * reply that scrolled out of sight as it was written would be unreadable
 * exactly when it mattered.
 */
/**
 * The card's links.
 *
 * The companion's window is created with a `deny-all` navigation policy, so an
 * ordinary `target="_blank"` anchor is refused by the window-open handler and
 * the press does nothing at all. The URL goes to the host instead, which opens
 * it in the user's browser where a link from a floating panel belongs.
 */
function CompanionLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={href}
      className="underline decoration-white/30 underline-offset-2 hover:decoration-white/60"
      onClick={(event) => {
        event.preventDefault();
        if (href !== undefined) {
          openCompanionLink(href);
        }
      }}
      // A press on a link is not a grab, the way a press on a control is not.
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </a>
  );
}

const linkComponent = CompanionLink;

function RecentTurns({ turns }: { turns: CompanionTurn[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [turns]);

  return (
    <div
      ref={scrollRef}
      // Selectable, against the surface's `select-none`. That rule is there so
      // a drag across the controls does not highlight their labels, and this is
      // the one part of the surface that is prose rather than chrome: an answer
      // the user may well want to copy out of.
      className="relative flex flex-col gap-1.5 overflow-y-auto px-3 pt-3 pb-1 select-text"
      style={{ maxHeight: TURNS_MAX_HEIGHT }}
    >
      {/* Sides, as the transcript does it: the user's turn is a bubble pushed
          right and capped at 80%, the assistant's is plain text filling the
          width. Matching `transcript-message-body.tsx` matters more than it
          looks, because this is a condensed read of the same conversation and a
          reader should not have to work out who said what a second time in a
          second idiom. */}
      {turns.map((turn, index) => {
        const isUser = turn.role === "user";
        return (
          <div
            key={`${turn.role}-${index}`}
            className={`flex shrink-0 ${isUser ? "justify-end" : "justify-start"}`}
          >
            {/* Whole, not clamped. Clamping belonged to a card that showed the
                last two turns and nothing else; now that the conversation
                scrolls, a cut-off reply would be text the user can see the top
                of and has no way to reach the rest of. */}
            {isUser ? (
              // The user's own words, exactly as they typed them. Rendering a
              // person's message as markdown reformats what they wrote back at
              // them, which the transcript does not do either.
              <p className="max-w-[80%] rounded-lg bg-white/[0.08] px-2.5 py-1.5 text-[12px] leading-[1.45] whitespace-pre-wrap text-white/75">
                {turn.text}
              </p>
            ) : (
              // The reply, formatted. The assistant writes markdown, so the
              // alternative is a card showing the user its asterisks and
              // backticks while the same reply reads properly in the app.
              //
              // The design-library primitive rather than the chat domain's
              // wrapper: that one carries OAuth link handling, attachments and
              // inline media, none of which a floating panel can do anything
              // with. The type scale is pinned down to the card's own 12px,
              // since the primitive is authored for a full-width transcript.
              // **`data-theme="dark"` is not a preference here, it is a
              // statement of fact.** The surface paints its own near-black
              // body in every theme, and the design library resolves its
              // content tokens from the nearest `[data-theme]`. Left to the
              // host's theme, a light-mode user gets `--content-default` at
              // #24292E on a #17181b card, which is prose they cannot read.
              <div
                data-theme="dark"
                className="companion-markdown min-w-0 text-[12px] leading-[1.45] text-white/85"
              >
                <MarkdownMessage
                  content={turn.text}
                  linkComponent={linkComponent}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Where you type, on the row the avatar is already on.
 *
 * It takes the place of Talk and Type rather than sitting under them, so
 * pressing Type changes what the pill contains without changing what the pill
 * is: empty, focused, or full of text, it is the same elongated single line as
 * the voice states. Growth happens above it, never to it.
 *
 * **It carries the stop control while a watch session runs**, because the card
 * is the one state with no control row of its own and the ring around it says
 * the screen is being read in every state. An indicator the user can see and
 * cannot act on is a worse bargain than no indicator: it names something
 * happening to them and withholds the means to end it. The row is where it fits
 * without cost, since the card is a fixed {@link CARD_WIDTH} and the field
 * takes the space out of its own flexible width rather than out of the card's,
 * and a row added above would push the card past the canvas main sized for it.
 */
function Composer({
  assistantName,
  watching,
  onSubmit,
  onCancel,
  onWatch,
}: {
  assistantName: string;
  /**
   * Whether a watch session is running, so the card can carry the way to end
   * it. The card replaces the pill while it is open, and a session the user
   * cannot stop without first closing the thing they are typing into is a
   * session they cannot stop.
   */
  watching: boolean;
  onSubmit?: (message: string) => void;
  onCancel?: () => void;
  onWatch?: () => void;
}) {
  const { t } = useTranslation();
  // The draft is the composer's own and never leaves except as a submitted
  // message. Holding it in the page instead would re-render the whole surface,
  // and the creature animating inside it, on every keystroke.
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const message = draft.trim();

  // The caret goes where the press just asked for one. This component mounts
  // with the card, so focusing on mount is the whole of it: pressing Type is
  // pressing "let me type", and a field the user has to click a second time to
  // use is a field that failed to do what it was asked.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = () => {
    if (message === "") {
      return;
    }
    setDraft("");
    onSubmit?.(message);
  };

  return (
    // Flush inside the row, which carries the clearance at both ends for the
    // composer and the control rows alike.
    <div className="relative flex min-w-0 flex-1 items-center gap-1">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder={t("companionSurface.messagePlaceholder", {
          name: assistantName,
        })}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        // Enter sends and Escape backs out, which is the whole keyboard here:
        // the field is one line, so there is no newline to protect.
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            send();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel?.();
          }
        }}
        // A press in the field is not a drag, and the field wants the caret
        // that press would otherwise be stolen from.
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-white/85 select-text placeholder:text-white/40 focus:outline-none"
      />
      {watching && <StopWatchingButton onWatch={onWatch} />}
      {/* **The way out, and the way on, in one control.** With nothing typed
          there is nothing to send, so the trailing control is the way back to
          the pill; the moment there are words it becomes the way to send them.
          A card whose only control was a dead send arrow would be a state the
          user could enter and not leave, and a second permanent button for
          "never mind" would spend a third of the row on the thing the user
          wants least. */}
      <button
        type="button"
        aria-label={
          message === ""
            ? t("companionSurface.goBack")
            : t("companionSurface.send")
        }
        title={
          message === ""
            ? t("companionSurface.goBack")
            : t("companionSurface.send")
        }
        onClick={message === "" ? onCancel : send}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 text-white/85 transition-colors hover:bg-white/20"
      >
        {message === "" ? (
          <X className="size-3.5" aria-hidden />
        ) : (
          <ArrowUp className="size-3.5" aria-hidden />
        )}
      </button>
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
 * The glow sits behind the image and is blurred well past it, so it falls off
 * into the desktop rather than ending on an edge. A halo sized to its own
 * source has nowhere to fall off and reads as a ring around the avatar rather
 * than as light coming off it.
 *
 * **The bob is a wrapper, not a class on the artwork.** `AnimatedAvatar` owns
 * `transform` on its own `<svg>` for the breathe and the morph, and a second
 * animation on that node would silently replace one of them. Everything that
 * belongs to the creature rides inside the wrapper, glow included, so the light
 * travels with what is casting it. The edge sits outside the wrapper: it is
 * drawn on the box rather than on the artwork, so a ring saying something is
 * running holds still while the creature breathes under it.
 */
function Avatar({
  accentHex,
  avatarSrc,
  character,
  busy = false,
  attentive = false,
  edge,
  style,
  elementRef,
  onMouseDown,
  onContextMenu,
  onClick,
}: {
  accentHex: string;
  avatarSrc?: string;
  character?: CompanionCharacter;
  busy?: boolean;
  attentive?: boolean;
  /** What the creature's edge is drawing. See `edge` in `CompanionSurface`. */
  edge?: ReactNode;
  style?: CSSProperties;
  elementRef?: Ref<HTMLDivElement>;
  onMouseDown?: (event: ReactMouseEvent<HTMLDivElement>) => void;
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
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onClick={onClick}
    >
      {edge}
      <div
        className="companion-avatar-bob relative grid place-items-center"
        style={{ animation: reduce ? "none" : undefined }}
      >
        <span
          className="companion-glow absolute size-10 rounded-full blur-lg"
          style={{
            background: accentHex,
            animation: reduce ? "none" : undefined,
          }}
          aria-hidden
        />
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
  );
}

/**
 * Expanded, with the app idle: the ways in.
 *
 * Verbs throughout. "Talk" and "Type" rather than "Talk" and "Ask", because
 * they are two halves of one choice about how to say something, and a verb pair
 * reads as that where a verb and a question word do not. "Teach" is the third,
 * and the one where the assistant does the looking rather than the user the
 * saying. It is also the one that comes and goes: it is behind a flag of its
 * own, so the row is Talk and Type alone for anyone who does not have it.
 *
 * **The words are drawn one at a time, under the pointer** (`revealLabel`).
 * This is the row a user meets by resting a hand near the mascot, so it is
 * drawn far more often than it is acted on, and three verbs spelled out at once
 * read as a sentence aimed at someone doing something else. Teach is the
 * loudest of the three for being the least wanted: the flagged, occasional way
 * in, at the same weight as the two the row exists for.
 *
 * Resting as icons keeps the pill to a third of the width its labels want, and
 * revealing one at a time is what keeps the reveal legible: exactly one word is
 * ever on the surface, and it is the one the hand is on.
 *
 * `aria-label` carries the name in every state, so a reader gets all three
 * regardless of where the pointer is.
 */
function IdleBody({
  spotlight,
  watching = false,
  watchEnabled = false,
  onTalk,
  onType,
  onWatch,
}: {
  spotlight?: "talk" | "type";
  /** Whether the session Watch starts is already running. */
  watching?: boolean;
  /** Whether Watch is offered at all. See `CompanionSurfaceProps`. */
  watchEnabled?: boolean;
  onTalk?: () => void;
  onType?: () => void;
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
      <PillButton
        icon={<Keyboard className="size-4" />}
        label={t("companionSurface.type")}
        revealLabel
        active={spotlight === "type"}
        onClick={onType}
      />
      {/* Held down for as long as the session runs, so the row says which
          control is holding the pill open and which press ends it. `pressed`
          rather than `active`, because this one is a state and not a look: a
          reader is told a session is running, where everything else this
          surface does about it is a colour they never receive.

          It is also what keeps this control's word on the surface while the
          rest of the row is icons: a running session is the one thing here the
          user has to be able to find without hunting, and a name revealed only
          under the pointer is one they would have to go looking for. `pressed`
          pins it open, so the session names itself for as long as it runs.

          Absent entirely when Watch is not offered, rather than disabled: a
          user who cannot have the feature is not owed a control that explains
          itself by refusing them. The pill measures its own contents, so the
          row simply comes out narrower.

          **The exit outlives the door.** A session running under a flag that
          has since been turned off still reads the screen, so the row that
          would have carried Watch carries the stop instead, the same control
          the card and the call row draw. Hiding the way in is the whole of what
          the flag does; leaving a capture with nothing that ends it is not
          something a flag is allowed to cause. */}
      {watchEnabled ? (
        <PillButton
          icon={<Eye className="size-4" />}
          label={t("companionSurface.teach")}
          revealLabel
          pressed={watching}
          onClick={onWatch}
        />
      ) : (
        watching && <StopWatchingButton onWatch={onWatch} />
      )}
    </>
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
  watching,
  onControl,
  onWatch,
}: {
  call?: VoiceActivityState;
  watching: boolean;
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
  onWatch?: () => void;
}) {
  const { t } = useTranslation();
  // The confirmation takes the row rather than crowding into it. The turn is
  // stopped until it is answered, so it is the only thing here worth pressing,
  // and a pill that tried to carry five controls would make each of them a
  // smaller target than the decision deserves.
  //
  // The watch session's stop control is among what it excludes. The row already
  // measures within a couple of points of the canvas ceiling, and what a canvas
  // too narrow does is clip its trailing control, so adding one here risks
  // clipping Deny. A blocked turn is reading nothing while it waits, and
  // answering it lands back on the row that carries the stop.
  if (call !== undefined && call.approvalRequestId !== "") {
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
  const line = call === undefined ? "Listening" : call.detail || call.label;
  const muted = call?.muted ?? false;
  const outputMuted = call?.outputMuted ?? false;

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
          and only one of the two is irreversible. */}
      {watching && <StopWatchingButton onWatch={onWatch} />}
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
      {/* The room's own end control, at pill scale: the same glyph at the same
          weight in the same destructive tone. Ending a call is the one
          irreversible thing on this surface, so it looks identical wherever the
          user meets it. */}
      <PillButton
        icon={<X className="size-4" strokeWidth={2.5} />}
        label={t("companionSurface.endSession")}
        tone="negative"
        onClick={() => {
          onControl?.("endSession");
        }}
      />
    </>
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
 * drifted between the composer and the call row would be two different controls
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
      onMouseDown={(event) => {
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
