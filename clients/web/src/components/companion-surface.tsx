import { AudioLines, Mic, MessageSquareText, Volume2, X } from "lucide-react";
import type { CSSProperties, ReactNode, Ref } from "react";

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
 * **Solid, not glass, and that is forced.** An earlier pass used
 * `backdrop-blur`, which samples what is behind it *within the page*; in an
 * Electron window that is nothing, because the desktop is not in the page. The
 * only real blur is the window's native vibrancy material, and a window's
 * material fills the window. This one is a canvas many times the size of the
 * pill, so asking for glass would frost a rectangle across the desktop instead.
 * Sizing the window to the pill would buy real glass at the cost of resizing it
 * on every expansion, which is the thing the fixed canvas exists to avoid.
 *
 * So the pill paints its own near-opaque background, as the dictation overlay
 * does and as Wispr's own pill does. That also settles what used to be the open
 * contrast question: a surface that carries its own background is readable over
 * a pale desktop and a busy one alike.
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

export type CompanionSurfacePhase = "resting" | "hover" | "call";

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

// Same pill, two widths. The call carries a phase, a clock and three controls
// where hover carries two choices, and hover is sized to just clear its two
// labels so the pill reads as the options and nothing else.
const WIDTHS: Record<CompanionSurfacePhase, number> = {
  resting: AVATAR_BOX,
  hover: 188,
  call: 296,
};

export interface CompanionSurfaceProps {
  phase: CompanionSurfacePhase;
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
   * Expand. Wired to the avatar alone, never to the surface: the circle is the
   * only part of this on screen at rest, so anything larger would arm from
   * empty space the user cannot see.
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
}

export function CompanionSurface({
  phase,
  glow = true,
  accentHex = DEFAULT_ACCENT,
  avatarSrc,
  onHoverStart,
  onHoverEnd,
  anchor = "center",
  rootRef,
}: CompanionSurfaceProps) {
  const expanded = phase !== "resting";
  const width = WIDTHS[phase];

  // Positioned against the avatar's resting footprint, so `left`/`right` pin
  // that edge and the body grows away from it, while `center` splits the growth
  // and drifts the avatar by half. Only `center` needs the negative margin, and
  // only `center` animates it.
  const placement: CSSProperties =
    anchor === "left"
      ? { left: 0 }
      : anchor === "right"
        ? { right: 0 }
        : { left: "50%", marginLeft: -(width / 2) };

  const style: CSSProperties = {
    width,
    ...placement,
    transform: "translateY(-50%)",
    // Settles rather than overshoots. A surface on screen all day should not
    // bounce every time the pointer crosses it.
    transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
    ["--accent" as string]: accentHex,
  };

  return (
    <div
      className="absolute top-1/2 flex h-11 items-center rounded-full border border-white/10 bg-[#17181b]/95 shadow-lg shadow-black/40 transition-[width,margin-left] duration-300 will-change-[width,margin-left]"
      style={style}
      onMouseLeave={onHoverEnd}
      ref={rootRef}
    >
      <Avatar
        glow={glow && !expanded}
        accentHex={accentHex}
        avatarSrc={avatarSrc}
        onMouseEnter={onHoverStart}
      />
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden pr-2 transition-opacity duration-200"
        style={{
          opacity: expanded ? 1 : 0,
          // Contents fade after the body has somewhere to put them, so nothing
          // is ever drawn wider than the pill carrying it.
          transitionDelay: expanded ? "120ms" : "0ms",
        }}
      >
        {phase === "call" ? <CallBody /> : <IdleBody />}
      </div>
    </div>
  );
}

/**
 * The avatar, and the only part of the surface that arms the expansion.
 *
 * The glow sits behind the image rather than around the 44px box, so it reads
 * as the avatar being lit rather than as a ring drawn near it. It is also the
 * one thing here sized to the box instead of the image: a halo the size of its
 * source has nowhere to fall off.
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
          className="absolute size-9 animate-pulse rounded-full blur-md"
          style={{ background: accentHex, opacity: 0.45 }}
          aria-hidden
        />
      )}
      {avatarSrc === undefined ? (
        // Until the avatar resolves, a disc in its colour. Same 28px, so
        // nothing about the geometry moves when the image lands.
        <span
          className="relative size-7 rounded-full"
          style={{ background: accentHex }}
          aria-hidden
        />
      ) : (
        <img
          src={avatarSrc}
          alt=""
          className="relative size-7 rounded-full object-contain"
        />
      )}
    </div>
  );
}

/** Expanded, with the app idle: the two ways in. */
function IdleBody() {
  return (
    <>
      <PillButton icon={<AudioLines className="size-4" />} label="Talk" showLabel />
      <PillButton
        icon={<MessageSquareText className="size-4" />}
        label="Ask"
        showLabel
      />
    </>
  );
}

/** Expanded, mid-call: the session's own controls, at pill scale. */
function CallBody() {
  return (
    <>
      <span className="ml-1 flex min-w-0 items-center gap-1.5">
        <Mic className="size-3.5 shrink-0 text-[var(--accent)]" aria-hidden />
        <span className="truncate text-[12px] text-white/85">Listening</span>
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-white/60">
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
}: {
  icon: ReactNode;
  label: string;
  tone?: "negative";
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] transition-colors hover:bg-white/15 ${
        tone === "negative" ? "text-[#ff6b6b]" : "text-white/85"
      }`}
    >
      {icon}
      {showLabel && <span>{label}</span>}
    </button>
  );
}
