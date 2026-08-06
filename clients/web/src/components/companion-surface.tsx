import {
  ArrowUp,
  AudioLines,
  Keyboard,
  Mic,
  Volume2,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
} from "react";

/**
 * The macOS companion surface (LUM-3086): the assistant's avatar floating from
 * app launch, expanding into a pill that carries the voice and type-chat
 * options, and expanding the same way while a call runs.
 *
 * **Bloom.** The body grows both ways from an avatar that holds its place,
 * which reads as the surface breathing rather than sliding. Anchoring is
 * therefore a position (`left: 50%` plus a negative margin) rather than a
 * transform, so the avatar stays put while the body widens around it.
 *
 * **Bloom needs clearance on both sides**, `(width - 44) / 2` of it: 72px
 * expanded and 126px in a call. A circle parked against a screen edge does not
 * have it, and unclamped the pill grows straight past the edge, taking the
 * avatar with it rather than merely the far control. So the surface flips
 * instead of clipping, the way a menu does, through {@link anchor}.
 *
 * Pleasingly, the flips are the three expansions that lost to bloom: anchoring
 * left is unfurl-right, anchoring right is slide-left. They were not wasted,
 * they are what bloom degrades into when the screen runs out.
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
 * 1. **The microphone glyph means two things in a call**, "listening" and
 *    "mute", forty pixels apart. The shipped voice panel has the same
 *    collision, so it is worth solving once rather than twice.
 * 2. **Nothing marks a live call while resting.** The circle looks identical
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
 * Which way the pill is allowed to grow, positioned against the avatar's
 * resting footprint.
 *
 * `center` blooms both ways and is the shape this is designed around. The other
 * two are what it degrades to when a screen edge is too close for the 126px a
 * call needs, and the main process is what decides: it owns the window's
 * position and is the only side that knows which display it is on.
 */
export type CompanionSurfaceAnchor = "center" | "left" | "right";

/** Fallback accent, used until the assistant's own avatar colour is known. */
const DEFAULT_ACCENT = "#5eead4";

// The avatar is a fixed 44px disc in every state; only the body around it
// changes. That is what makes this one surface expanding rather than three
// surfaces that happen to share a colour, and it is the property to protect as
// the states gain content.
const AVATAR_BOX = 44;

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
 * Lines each turn gets before it is cut off.
 *
 * The card is a glance at the conversation, not the conversation. The assistant
 * gets one more line than the user because the user already knows what they
 * said.
 */
const USER_LINE_CLAMP = 2;
const ASSISTANT_LINE_CLAMP = 4;

/** One side of one exchange, condensed for the card. */
export interface CompanionTurn {
  role: "user" | "assistant";
  text: string;
}

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
   */
  avatarSrc?: string;
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
  /** Which way the pill may grow. See {@link CompanionSurfaceAnchor}. */
  anchor?: CompanionSurfaceAnchor;
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
}

export function CompanionSurface({
  phase,
  turns = [],
  assistantName = "your assistant",
  glow = true,
  accentHex = DEFAULT_ACCENT,
  avatarSrc,
  onHoverStart,
  onHoverEnd,
  anchor = "center",
  rootRef,
  onSurfaceMouseDown,
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

  // **Every anchor keeps the avatar on the same spot.** The host positions this
  // window around the avatar, not around the pill, so the avatar's resting box
  // is always the centre of the canvas and only the direction the body grows in
  // may change. Pinning the pill to a canvas edge instead throws the avatar
  // half a canvas away from where the host put it, which at the default
  // bottom-right launch position is off the screen entirely.
  //
  // So each anchor fixes the avatar's own edge to the centre and lets the body
  // run the other way: right-anchored also reverses the row, because the body
  // has to end up on the avatar's left.
  const placement: CSSProperties =
    anchor === "left"
      ? { left: "50%", marginLeft: -(AVATAR_BOX / 2) }
      : anchor === "right"
        ? { right: "50%", marginRight: -(AVATAR_BOX / 2) }
        : { left: "50%", marginLeft: -(width / 2) };

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
      className={`absolute top-1/2 cursor-grab transition-[width,margin-left,margin-right] duration-300 will-change-[width,margin-left,margin-right] active:cursor-grabbing ${
        typing
          ? "flex flex-col rounded-[22px]"
          : "flex h-11 items-center rounded-full"
      } ${
        // The avatar is the row's first child, so growing leftward means
        // reversing the row rather than repositioning it. The card is a column
        // and grows upward instead, so it never wants this.
        anchor === "right" && !typing ? "flex-row-reverse" : ""
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
          onMouseEnter={onHoverStart}
        />
        {typing ? (
          <Composer assistantName={assistantName} />
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
            {phase === "call" ? <CallBody /> : <IdleBody />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The tail of the conversation, stacked above the composer.
 *
 * Deliberately not a transcript. Two turns at most and a few lines each,
 * because a surface floating over someone else's work is a glance at where the
 * conversation got to, and the app is where the thread actually lives. Anything
 * longer would be a chat window that happens to be always on top.
 */
function RecentTurns({ turns }: { turns: CompanionTurn[] }) {
  // Oldest first, so the newest sits nearest the composer as it does in the app.
  const recent = turns.slice(-2);
  return (
    <div className="relative flex flex-col gap-1.5 px-3 pt-3 pb-1">
      {/* Sides, as the transcript does it: the user's turn is a bubble pushed
          right and capped at 80%, the assistant's is plain text filling the
          width. Matching `transcript-message-body.tsx` matters more than it
          looks, because this is a condensed read of the same conversation and a
          reader should not have to work out who said what a second time in a
          second idiom. */}
      {recent.map((turn, index) => {
        const isUser = turn.role === "user";
        return (
          <div
            key={`${turn.role}-${index}`}
            className={`flex ${isUser ? "justify-end" : "justify-start"}`}
          >
            <p
              className={`text-[12px] leading-[1.45] ${
                isUser
                  ? "max-w-[80%] rounded-lg bg-white/[0.08] px-2.5 py-1.5 text-white/75"
                  : "text-white/85"
              }`}
              style={{
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: isUser ? USER_LINE_CLAMP : ASSISTANT_LINE_CLAMP,
                overflow: "hidden",
              }}
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
function Composer({ assistantName }: { assistantName: string }) {
  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1 pr-2">
      <input
        type="text"
        placeholder={`Message ${assistantName}`}
        // A press in the field is not a drag, and the field wants the caret
        // that press would otherwise be stolen from.
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-white/85 placeholder:text-white/40 focus:outline-none"
      />
      <button
        type="button"
        aria-label="Send"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        className="grid size-7 shrink-0 place-items-center rounded-full bg-white/10 text-white/85 transition-colors hover:bg-white/20"
      >
        <ArrowUp className="size-3.5" aria-hidden />
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
  onMouseEnter,
}: {
  glow: boolean;
  accentHex: string;
  avatarSrc?: string;
  onMouseEnter?: () => void;
}) {
  return (
    <div
      className="relative grid size-11 shrink-0 place-items-center"
      onMouseEnter={onMouseEnter}
    >
      {glow && (
        <span
          className="absolute size-10 animate-pulse rounded-full blur-lg"
          style={{ background: accentHex, opacity: 0.4 }}
          aria-hidden
        />
      )}
      {avatarSrc === undefined ? (
        // Until the avatar resolves, a disc in its colour. Same 28px, so
        // nothing about the geometry moves when the image lands.
        <span
          className="relative size-7 rounded-full drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]"
          style={{ background: accentHex }}
          aria-hidden
        />
      ) : (
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
function IdleBody() {
  return (
    <>
      <PillButton icon={<AudioLines className="size-4" />} label="Talk" showLabel />
      <PillButton
        icon={<Keyboard className="size-4" />}
        label="Type"
        showLabel
      />
    </>
  );
}

/** Expanded, mid-call: the session's own controls, at pill scale. */
function CallBody() {
  return (
    <>
      {/* Sized to its content, not shrunk to fit. The pill now measures this
          row to decide how wide to be, so a label that collapses under pressure
          would measure its own collapsed self: the width and the truncation
          would chase each other down. The cap is what keeps a pathological
          label from growing the pill without bound. */}
      <span className="ml-1 flex shrink-0 items-center gap-1.5">
        <Mic className="size-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        <span className="max-w-[140px] truncate text-[12px] text-white/85">
          Listening
        </span>
      </span>
      <span className="ml-1 shrink-0 font-mono text-[11px] tabular-nums text-white/60">
        0:14
      </span>
      <PillButton icon={<Mic className="size-4" />} label="Mute microphone" />
      <PillButton icon={<Volume2 className="size-4" />} label="Mute assistant" />
      <PillButton
        icon={<X className="size-4" strokeWidth={2.5} />}
        label="End session"
        tone="negative"
      />
    </>
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
}: {
  icon: ReactNode;
  label: string;
  tone?: "negative";
  showLabel?: boolean;
  /** Held down, for a control whose surface is currently open. */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // A press on a control is not the start of a drag. Without this the
      // surface would move under a click meant to activate something on it.
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] transition-colors hover:bg-white/15 ${
        active ? "bg-white/10" : ""
      } ${tone === "negative" ? "text-[#ff6b6b]" : "text-white/85"}`}
    >
      {icon}
      {showLabel && <span>{label}</span>}
    </button>
  );
}
