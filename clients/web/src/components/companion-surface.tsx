import {
  ArrowUp,
  AudioLines,
  Check,
  Keyboard,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
} from "react";

import type {
  CompanionCharacter,
  CompanionTurn,
  VoiceActivityControlAction,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The macOS companion surface (LUM-3086): the assistant's avatar floating from
 * app launch, expanding into a pill that carries the voice and type-chat
 * options, and expanding the same way while a call runs.
 *
 * **The mascot is the fixed point.** The body unfurls out of an avatar that
 * holds one x-position in every state, so the surface reads as one object
 * changing shape rather than a series of different objects, and the eye and the
 * cursor always have the same target to aim at. Placement is therefore a
 * position (`left: 50%` plus the avatar's own half-width) rather than a
 * transform, and only `width` animates.
 *
 * **Growth needs clearance on the side it runs into**, `width - 44` of it: 144px
 * expanded and 316px in a call. A circle parked against the right edge does not
 * have it, and unclamped the body would run straight off the display with the
 * controls the user was reaching for. So the surface flips and grows the other
 * way instead, the way a menu does, through {@link growth}.
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

// The avatar is a fixed 44px disc in every state; only the body around it
// changes. That is what makes this one surface expanding rather than three
// surfaces that happen to share a colour, and it is the property to protect as
// the states gain content.
const AVATAR_BOX = 44;

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
const INNER_GAP = 8;

/**
 * Widths to use until the content has been measured.
 *
 * The real width is the avatar plus whatever the body actually needs, measured
 * at runtime, because a fixed width is only ever right by accident: the pill
 * was 188pt against a body that wanted less, and `flex-1` piled the difference
 * up after the last control as dead space, so the right end sat further from
 * its content than the left did from the avatar.
 *
 * Measuring is also what makes the surface survive its own roadmap. Once
 * plugins contribute actions (LUM-3097) no hardcoded number can be correct, and
 * these become nothing but the value for the first frame.
 */
const FALLBACK_WIDTHS: Record<CompanionSurfacePhase, number> = {
  resting: AVATAR_BOX,
  hover: 188,
  call: 296,
  typing: 360,
};

/**
 * The card is a fixed width, unlike the pills.
 *
 * A pill is as wide as its controls and nothing more, so measuring is the only
 * honest answer. A card holds wrapped prose, and prose has no natural width:
 * measuring it would size the card to whatever the last turn happened to say
 * and reflow the whole surface on every message.
 */
const CARD_WIDTH = 360;

/**
 * The tallest the conversation gets before it scrolls.
 *
 * The card is still a card, not a chat window: it holds a readable stretch of
 * the exchange and the rest is scrolled to, so a long reply can be read in
 * place without the surface growing until it runs off the top of the display.
 * Whatever this is, `MAX_CARD_HEIGHT` in `companion-window.ts` has to be sized
 * to hold it plus the composer row.
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
  /** The resting circle's ambient halo, in the avatar's own colour. */
  glow?: boolean;
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
   * Passed rather than derived from `phase`, because a call holds the pill open
   * regardless of the pointer and the mascot should still notice a hand
   * arriving over it mid-call.
   */
  hovered?: boolean;
  /**
   * Expand. Wired to the avatar alone, never to the surface: at rest the two
   * are the same box, but arming from anything larger than what is drawn would
   * expand the surface from empty space the user cannot see.
   */
  onHoverStart?: () => void;
  /**
   * Collapse. Wired to the whole surface rather than the avatar, because once
   * expanded the pointer has to be able to travel from the avatar to the
   * controls. Leaving on the avatar would collapse the pill out from under the
   * hand reaching for it, and while resting the surface *is* the avatar, so
   * the two agree exactly when it matters.
   */
  onHoverEnd?: () => void;
  /** Which way the pill grows. See {@link CompanionSurfaceGrowth}. */
  growth?: CompanionSurfaceGrowth;
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
   * Begin a drag. Everything that is not a control is a handle, so this is
   * wired to the surface and the controls stop the press from reaching it.
   */
  onSurfaceMouseDown?: (event: ReactMouseEvent<HTMLDivElement>) => void;
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
}

export function CompanionSurface({
  phase,
  turns = [],
  assistantName = "your assistant",
  glow = true,
  accentHex = DEFAULT_ACCENT,
  avatarSrc,
  character,
  hovered = false,
  onHoverStart,
  onHoverEnd,
  growth = "right",
  rootRef,
  onSurfaceMouseDown,
  spotlight,
  onTalk,
  onType,
  onSubmit,
  onCancelTyping,
  onAvatarClick,
  call,
  onControl,
}: CompanionSurfaceProps) {
  const expanded = phase !== "resting";
  const typing = phase === "typing";
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

  // The avatar's 44pt box sits flush, because its image is already inset by
  // `INNER_GAP` inside it. Only the trailing end needs the gap added, since the
  // last control's own box ends where the body does.
  const width = typing
    ? CARD_WIDTH
    : AVATAR_BOX +
      (!expanded
        ? 0
        : (contentWidth ?? FALLBACK_WIDTHS[phase] - AVATAR_BOX) + INNER_GAP);

  // **The avatar never moves.** It is pinned to the centre of the canvas, which
  // is the spot the host positions this window around, and the body runs off
  // one side of it. Growing from the pill's centre instead would slide the
  // mascot to a different x-position in every state, so the surface would read
  // as a series of different objects rather than one object changing shape, and
  // the user's eye and cursor would have no fixed target to aim at.
  //
  // Each direction therefore fixes the avatar's own edge to the centre and lets
  // the body run the other way. Growing left also reverses the row, because the
  // body has to end up on the avatar's left.
  const placement: CSSProperties =
    growth === "left"
      ? { right: "50%", marginRight: -(AVATAR_BOX / 2) }
      : { left: "50%", marginLeft: -(AVATAR_BOX / 2) };

  const style: CSSProperties = {
    width,
    ...placement,
    // The composer row holds the line the pill occupied and the conversation
    // stacks upward off it, so the avatar never moves when Type is pressed and
    // never moves again as turns arrive. It is also the only direction that
    // works where this surface lives: parked by the Dock, a card growing down
    // grows off the bottom of the screen.
    transform: typing
      ? `translateY(calc(-100% + ${AVATAR_BOX / 2}px))`
      : "translateY(-50%)",
    // Settles rather than overshoots. A surface on screen all day should not
    // bounce every time the pointer crosses it.
    transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
    ["--accent" as string]: accentHex,
  };

  return (
    // The whole surface is the drag handle. Controls opt out by stopping the
    // press, so everything that is not a button can be grabbed, which at rest
    // means the avatar and when expanded means the pill around the controls.
    <div
      className={`absolute top-1/2 cursor-grab transition-[width] duration-300 will-change-[width] active:cursor-grabbing ${
        typing
          ? "flex flex-col rounded-[22px]"
          : "flex h-11 items-center rounded-full"
      } ${
        // The avatar is the row's first child, so growing leftward means
        // reversing the row rather than repositioning it. The card is a column
        // and grows upward instead, so it never wants this.
        growth === "left" && !typing ? "flex-row-reverse" : ""
      }`}
      style={style}
      onMouseLeave={onHoverEnd}
      onMouseDown={onSurfaceMouseDown}
      ref={rootRef}
    >
      {/* The pill's body, which exists only once there is a pill. At rest the
          surface is the avatar and nothing else: a dark disc with a border
          drawn around a round avatar reads as a hard ring the avatar happens to
          sit inside, and stacked under the glow it is two rings. Fading the
          body in with the expansion also gives the avatar something to grow
          out of. */}
      <span
        className={`absolute inset-0 border border-white/10 bg-[#17181b]/95 shadow-lg shadow-black/40 transition-opacity duration-200 ${
          // Radius follows the same rule as the gap: the controls are 28pt so
          // their radius is 14, and 8pt of clearance puts the outer radius at
          // 22. A pill happens to reach that by being 44 tall; the card has to
          // say it.
          typing ? "rounded-[22px]" : "rounded-full"
        }`}
        style={{ opacity: expanded ? 1 : 0 }}
        aria-hidden
      />
      {typing && turns.length > 0 && <RecentTurns turns={turns} />}
      <div className="relative flex h-11 shrink-0 items-center">
        <Avatar
          glow={glow && !expanded}
          accentHex={accentHex}
          avatarSrc={avatarSrc}
          character={character}
          attentive={hovered}
          // The assistant's own turn. The creature stops blinking and holds a
          // focused, morphing pose, which is the same treatment the chat avatar
          // uses while a reply is streaming: one vocabulary for "it is working"
          // wherever the user meets it.
          busy={call !== undefined && ASSISTANT_TURN_PHASES.has(call.phase)}
          onMouseEnter={onHoverStart}
          onClick={onAvatarClick}
        />
        {typing ? (
          <Composer
            assistantName={assistantName}
            onSubmit={onSubmit}
            onCancel={onCancelTyping}
          />
        ) : (
          <div
            className="relative flex min-w-0 items-center gap-1 overflow-hidden transition-opacity duration-200"
            ref={contentRef}
            // Faded out is not gone: the body stays mounted while collapsed so
            // it can be measured, which would otherwise leave its controls
            // focusable and announced while nothing is drawn. `inert` takes
            // them out of the tab order and the accessibility tree without
            // taking them out of the DOM, so the measurement still works.
            inert={!expanded}
            style={{
              opacity: expanded ? 1 : 0,
              // Contents fade after the body has somewhere to put them, so
              // nothing is ever drawn wider than the pill carrying it.
              transitionDelay: expanded ? "120ms" : "0ms",
            }}
          >
            {phase === "call" ? (
              <CallBody call={call} onControl={onControl} />
            ) : (
              <IdleBody spotlight={spotlight} onTalk={onTalk} onType={onType} />
            )}
          </div>
        )}
      </div>
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
      className="relative flex flex-col gap-1.5 overflow-y-auto px-3 pt-3 pb-1"
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
            <p
              className={`text-[12px] leading-[1.45] whitespace-pre-wrap ${
                isUser
                  ? "max-w-[80%] rounded-lg bg-white/[0.08] px-2.5 py-1.5 text-white/75"
                  : "text-white/85"
              }`}
            >
              {turn.text}
            </p>
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
 */
function Composer({
  assistantName,
  onSubmit,
  onCancel,
}: {
  assistantName: string;
  onSubmit?: (message: string) => void;
  onCancel?: () => void;
}) {
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
    <div className="relative flex min-w-0 flex-1 items-center gap-1 pr-2">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder={`Message ${assistantName}`}
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
        className="min-w-0 flex-1 bg-transparent text-[12px] text-white/85 placeholder:text-white/40 focus:outline-none"
      />
      {/* **The way out, and the way on, in one control.** With nothing typed
          there is nothing to send, so the trailing control is the way back to
          the pill; the moment there are words it becomes the way to send them.
          A card whose only control was a dead send arrow would be a state the
          user could enter and not leave, and a second permanent button for
          "never mind" would spend a third of the row on the thing the user
          wants least. */}
      <button
        type="button"
        aria-label={message === "" ? "Go back" : "Send"}
        title={message === "" ? "Go back" : "Send"}
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
 * The avatar, and the only part of the surface that arms the expansion.
 *
 * The glow sits behind the image and is blurred well past it, so it falls off
 * into the desktop rather than ending on an edge. A halo sized to its own
 * source has nowhere to fall off and reads as a ring around the avatar rather
 * than as light coming off it.
 */
function Avatar({
  glow,
  accentHex,
  avatarSrc,
  character,
  busy = false,
  attentive = false,
  onMouseEnter,
  onClick,
}: {
  glow: boolean;
  accentHex: string;
  avatarSrc?: string;
  character?: CompanionCharacter;
  busy?: boolean;
  attentive?: boolean;
  onMouseEnter?: () => void;
  onClick?: () => void;
}) {
  return (
    // A div rather than a button even when it is pressable: it is the drag
    // handle for the whole surface, and the press that starts a drag must not
    // read as activating a control. `onClick` fires only for presses the caller
    // decided were not drags.
    <div
      className="relative grid size-11 shrink-0 place-items-center"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      {glow && (
        <span
          className="absolute size-10 animate-pulse rounded-full blur-lg"
          style={{ background: accentHex, opacity: 0.4 }}
          aria-hidden
        />
      )}
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
        <img
          src={avatarSrc}
          alt=""
          className="relative size-7 rounded-full object-contain drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]"
        />
      )}
    </div>
  );
}

/**
 * Expanded, with the app idle: the two ways in.
 *
 * "Talk" and "Type" rather than "Talk" and "Ask", because they are two halves
 * of one choice about how to say something, and a verb pair reads as that where
 * a verb and a question word do not.
 */
function IdleBody({
  spotlight,
  onTalk,
  onType,
}: {
  spotlight?: "talk" | "type";
  onTalk?: () => void;
  onType?: () => void;
}) {
  return (
    <>
      <PillButton
        icon={<AudioLines className="size-4" />}
        label="Talk"
        showLabel
        active={spotlight === "talk"}
        onClick={onTalk}
      />
      <PillButton
        icon={<Keyboard className="size-4" />}
        label="Type"
        showLabel
        active={spotlight === "type"}
        onClick={onType}
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
  onControl,
}: {
  call?: VoiceActivityState;
  onControl?: (action: VoiceActivityControlAction, requestId?: string) => void;
}) {
  // The confirmation takes the row rather than crowding into it. The turn is
  // stopped until it is answered, so it is the only thing here worth pressing,
  // and a pill that tried to carry five controls would make each of them a
  // smaller target than the decision deserves.
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
      <span className="ml-1 shrink-0 font-mono text-[11px] tabular-nums text-white/60">
        <Elapsed startedAt={call?.startedAt} />
      </span>
      <PillButton
        icon={
          muted ? <MicOff className="size-4" /> : <Mic className="size-4" />
        }
        label={muted ? "Unmute microphone" : "Mute microphone"}
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
        label={outputMuted ? "Unmute assistant" : "Mute assistant"}
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
        label="End session"
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
  return (
    <>
      {detail !== "" && (
        <span className="ml-1 max-w-[120px] shrink-0 truncate text-[12px] text-white/85">
          {detail}
        </span>
      )}
      <PillButton
        icon={<Check className="size-4" />}
        label="Allow"
        showLabel
        tone="positive"
        onClick={() => {
          onControl?.("approveRequest", requestId);
        }}
      />
      <PillButton
        icon={<X className="size-4" />}
        label="Deny"
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
 * Elapsed call time.
 *
 * Ticks from a timestamp the caller owns rather than one of its own, because
 * the session started before this component mounted and will outlive it: the
 * surface that renders this can reload mid-call. With no timestamp it holds a
 * fixed sample, which is what a static story wants.
 */
function Elapsed({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [startedAt]);

  if (startedAt === undefined) {
    return <>0:14</>;
  }
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <>{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</>
  );
}

/**
 * A control in the pill.
 *
 * `label` is always the accessible name; it is only drawn when the pill has
 * room for words, which is why the call's controls are icon-only without being
 * unlabelled.
 */
function PillButton({
  icon,
  label,
  tone,
  showLabel = false,
  active = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tone?: "positive" | "negative";
  showLabel?: boolean;
  /** Held down, for a control whose surface is currently open. */
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      // A press on a control is not the start of a drag. Without this the
      // surface would move under a click meant to activate something on it.
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] transition-colors hover:bg-white/15 ${
        active ? "bg-white/15" : ""
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
    </button>
  );
}
