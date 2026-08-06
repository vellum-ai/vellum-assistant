import { AudioLines, Mic, MessageSquareText, Volume2, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/**
 * The macOS companion surface (LUM-3086): the assistant's avatar floating from
 * app launch, expanding into a pill that carries the voice and type-chat
 * options, and expanding the same way while a call runs.
 *
 * **Bloom.** The body grows both ways from an avatar that holds its place,
 * which reads as the surface breathing rather than sliding and is the only
 * expansion with no preferred screen edge, so a circle the user parked anywhere
 * expands the same. Anchoring is therefore a position (`left: 50%` plus a
 * negative margin) rather than a transform: translating a growing pill slides
 * it off whichever edge it was parked against, which is the one thing a surface
 * living by the Dock cannot do.
 *
 * **Presentational only.** Phase comes from the caller, so this renders
 * identically in Storybook and in the Electron panel. Hover is a phase rather
 * than internal state because in the real window the pointer is tracked by the
 * main process through `setIgnoreMouseEvents(true, { forward: true })`, which
 * delivers mouse-move without capturing clicks meant for whatever is behind.
 *
 * **The glass here does not survive the port.** `backdrop-blur` samples what is
 * behind it *within the page*. In an Electron window it samples nothing,
 * because the desktop is not in the page. The real surface takes its blur from
 * the window's native vibrancy material, which is only visible over a
 * transparent window backing (LUM-3073 shipped an entire build where an opaque
 * backing hid it). Treat `backdrop-blur` as a stand-in for `vibrancy`.
 *
 * Open, and reproducible from the stories:
 *
 * 1. **Light desktops.** The pill assumes a dark backdrop; white on a 35% black
 *    scrim stops being readable over a pale one. Either the scrim stays dark
 *    whatever is behind it, or the surface adapts and the content adapts too.
 * 2. **The microphone glyph means two things in a call**, "listening" and
 *    "mute", forty pixels apart. The shipped voice panel has the same
 *    collision, so it is worth solving once rather than twice.
 * 3. **Nothing marks a live call while resting.** The circle looks identical
 *    whether or not the microphone is open, which is the state this surface
 *    exists to make visible.
 */

export type CompanionSurfacePhase = "resting" | "hover" | "call";

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
}

export function CompanionSurface({
  phase,
  glow = true,
  accentHex = DEFAULT_ACCENT,
}: CompanionSurfaceProps) {
  const expanded = phase !== "resting";
  const width = WIDTHS[phase];

  const style: CSSProperties = {
    width,
    left: "50%",
    marginLeft: -(width / 2),
    transform: "translateY(-50%)",
    // Settles rather than overshoots. A surface on screen all day should not
    // bounce every time the pointer crosses it.
    transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
    ["--accent" as string]: accentHex,
  };

  return (
    <div
      className="absolute top-1/2 flex h-11 items-center rounded-full border border-white/15 bg-black/35 backdrop-blur-xl transition-[width,margin-left] duration-300 will-change-[width,margin-left]"
      style={style}
    >
      <Avatar glow={glow && !expanded} accentHex={accentHex} />
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

function Avatar({ glow, accentHex }: { glow: boolean; accentHex: string }) {
  return (
    <div className="relative grid size-11 shrink-0 place-items-center">
      {glow && (
        <span
          className="absolute size-11 animate-pulse rounded-full blur-md"
          style={{ background: accentHex, opacity: 0.45 }}
          aria-hidden
        />
      )}
      {/* Stand-in for the assistant's avatar. The real one is an image at the
          same 28px, so nothing about the geometry changes when it lands. */}
      <span
        className="relative size-7 rounded-full"
        style={{
          background: `radial-gradient(circle at 32% 30%, #fff 0%, ${accentHex} 45%, #0f766e 100%)`,
        }}
        aria-hidden
      />
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
