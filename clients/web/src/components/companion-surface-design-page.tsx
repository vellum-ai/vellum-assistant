import { SegmentControl } from "@vellumai/design-library";
import { AudioLines, Mic, MessageSquareText, Volume2, X } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Design exploration for the macOS companion surface (LUM-3086): the
 * assistant's avatar floating from app launch, expanding on hover into a pill
 * carrying the voice and type-chat options, and expanding the same way when a
 * call starts.
 *
 * **This page is most of the real thing, not a mock.** The surface lives in a
 * transparent Electron canvas sized once to the widest state it can reach, the
 * shape `dictation-overlay-window.ts` already uses, so the circle-to-pill move
 * is a CSS problem inside a window that never resizes. What is drawn here is
 * what would be drawn there; only the window, the click-through toggling and
 * the real avatar are missing.
 *
 * Two things the browser cannot settle, which is why the winner has to be
 * promoted into the real window before it is called done: how the glass reads
 * over an arbitrary desktop rather than the fake backdrops below, and how the
 * resting circle sits against a real Dock.
 *
 * **The glass here is a lie, and deliberately so.** The pill uses
 * `backdrop-blur`, which samples what is behind it *within the page*. In an
 * Electron window it samples nothing, because the desktop is not in the page.
 * The real surface has to take its blur from the window's native vibrancy
 * material, and that material is only visible if the window is backed by a
 * transparent colour (LUM-3073 shipped a whole build where an opaque backing
 * hid it). So `backdrop-blur` is standing in for `vibrancy` here, and does not
 * survive the port.
 *
 * The candidates differ only in how the circle becomes the pill, since the
 * silhouette is decided. Delete the losers rather than keeping them behind a
 * flag; this route is a workbench, not a feature.
 */

type Phase = "resting" | "hover" | "call";
type Backdrop = "dark" | "light" | "busy";

/** The expansion each candidate is exploring. */
type Candidate = {
  key: string;
  name: string;
  note: string;
};

const CANDIDATES: Candidate[] = [
  {
    key: "slide-left",
    name: "Slide left",
    note: "The avatar travels left and the body unfurls behind it. Right edge stays put, so a circle parked by the Dock never grows off-screen.",
  },
  {
    key: "unfurl-right",
    name: "Unfurl right",
    note: "The avatar holds its spot and the body grows rightward. Cheapest to reason about, but it walks into whatever is to the right.",
  },
  {
    key: "bloom",
    name: "Bloom",
    note: "The body grows both ways from the avatar, which stays centred. Reads as the surface breathing rather than sliding.",
  },
  {
    key: "lift",
    name: "Lift",
    note: "Slide left plus a small rise and overshoot. The most obviously animated, and the easiest to tire of.",
  },
];

const BACKDROPS: Record<Backdrop, string> = {
  dark: "linear-gradient(140deg, #14161a 0%, #1d2026 55%, #0f1113 100%)",
  light: "linear-gradient(140deg, #f4f1ec 0%, #e6e9ef 55%, #dfe3ea 100%)",
  busy:
    "linear-gradient(120deg, #4c1d95 0%, #b91c1c 28%, #047857 58%, #1d4ed8 82%, #f59e0b 100%)",
};

/** Stand-in for the assistant's avatar and its accent. */
const ACCENT = "#5eead4";

/**
 * Initial state from the query string, so a particular comparison can be sent
 * to someone as a link and captured headlessly without driving the controls.
 * Unknown values fall back rather than throwing: this is a workbench, and a
 * typo in a URL should not blank the page.
 */
function initialFromQuery<T extends string>(
  param: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = new URLSearchParams(window.location.search).get(param);
  const match = allowed.find((value) => value === raw);
  return match ?? fallback;
}

export function CompanionSurfaceDesignPage() {
  const [phase, setPhase] = useState<Phase>(() =>
    initialFromQuery("phase", ["resting", "hover", "call"] as const, "resting"),
  );
  const [backdrop, setBackdrop] = useState<Backdrop>(() =>
    initialFromQuery("backdrop", ["dark", "light", "busy"] as const, "dark"),
  );
  const [glow, setGlow] = useState(
    () => new URLSearchParams(window.location.search).get("glow") !== "off",
  );
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-[var(--surface-base)] p-8 text-[var(--content-primary)]">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-[15px] font-semibold">
          Companion surface (LUM-3086)
        </h1>
        <p className="max-w-[70ch] text-[13px] text-[var(--content-secondary)]">
          Hover a candidate to expand it, or drive every candidate at once with
          the phase control. Glow is the resting circle&rsquo;s ambient halo in
          the avatar&rsquo;s own colour.
        </p>
      </header>

      <div className="mb-8 flex flex-wrap items-center gap-3">
        <div className="w-[260px]">
          <SegmentControl<Phase>
            ariaLabel="Phase"
            value={phase}
            onChange={setPhase}
            items={[
              { value: "resting", label: "Resting" },
              { value: "hover", label: "Hover" },
              { value: "call", label: "In call" },
            ]}
          />
        </div>
        <div className="w-[300px]">
          <SegmentControl<Backdrop>
            ariaLabel="Backdrop"
            value={backdrop}
            onChange={setBackdrop}
            items={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "busy", label: "Busy" },
            ]}
          />
        </div>
        <div className="w-[200px]">
          <SegmentControl<"on" | "off">
            ariaLabel="Resting glow"
            value={glow ? "on" : "off"}
            onChange={(next) => {
              setGlow(next === "on");
            }}
            items={[
              { value: "on", label: "Glow" },
              { value: "off", label: "No glow" },
            ]}
          />
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {CANDIDATES.map((candidate) => {
          // Hovering a candidate expands that one alone, so two treatments can
          // be compared mid-move without the phase control moving both.
          const effective: Phase =
            hovered === candidate.key && phase === "resting" ? "hover" : phase;
          return (
            <section key={candidate.key} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-3">
                <h2 className="text-[13px] font-semibold">{candidate.name}</h2>
                <p className="text-[12px] text-[var(--content-tertiary)]">
                  {candidate.note}
                </p>
              </div>
              <div
                className="relative h-[132px] w-[480px] overflow-hidden rounded-xl"
                style={{ background: BACKDROPS[backdrop] }}
                onMouseEnter={() => {
                  setHovered(candidate.key);
                }}
                onMouseLeave={() => {
                  setHovered(null);
                }}
              >
                <CompanionSurface
                  variant={candidate.key}
                  phase={effective}
                  glow={glow}
                />
              </div>
            </section>
          );
        })}
      </div>

      <footer className="mt-10 max-w-[70ch] text-[12px] text-[var(--content-tertiary)]">
        <p className="mb-2 font-semibold text-[var(--content-secondary)]">
          Open, and visible in the candidates above:
        </p>
        <ul className="flex list-disc flex-col gap-1 pl-4">
          <li>
            Switch the backdrop to Light. The pill assumes a dark desktop, and
            white on a 35% black scrim stops being readable. Either the scrim
            gets heavier and stays dark whatever is behind it (Wispr&rsquo;s
            answer), or the surface adapts and the content has to adapt with it.
          </li>
          <li>
            In a call the microphone glyph appears twice, once meaning
            &ldquo;listening&rdquo; and once meaning &ldquo;mute&rdquo;. The
            shipped panel has the same collision, so it is worth solving once,
            here, rather than twice.
          </li>
          <li>
            Nothing yet says a call is live when the surface is resting. The
            circle looks identical whether or not the microphone is open, which
            is the state this surface exists to make visible.
          </li>
        </ul>
      </footer>
    </div>
  );
}

/**
 * One candidate at one phase.
 *
 * The avatar is a fixed 44px disc in every state and every candidate; only the
 * body around it changes. That is what makes this one surface expanding rather
 * than three surfaces that happen to share a colour, and it is the property to
 * protect if the candidates diverge further.
 */
function CompanionSurface({
  variant,
  phase,
  glow,
}: {
  variant: string;
  phase: Phase;
  glow: boolean;
}) {
  const expanded = phase !== "resting";
  // The pill is wider in a call than on hover: the call carries a phase, a
  // clock and three controls where hover carries two choices. Same pill, two
  // widths, as agreed.
  const width = phase === "call" ? 296 : phase === "hover" ? 232 : 44;

  // The anchor is a position, not a transform. Growing a right-anchored pill
  // is what moves the avatar left, since the avatar is the pill's left end, so
  // the width change alone produces the motion. Translating instead would slide
  // the surface off whichever edge it was parked against, which is exactly what
  // a surface parked by the Dock cannot do.
  const anchor = (): CSSProperties => {
    switch (variant) {
      case "unfurl-right":
        return { left: 24 };
      case "bloom":
        return { left: "50%", marginLeft: -(width / 2) };
      default:
        return { right: 24 };
    }
  };

  const style: CSSProperties = {
    width,
    ...anchor(),
    // Vertical centring lives in the same transform as the lift, since a second
    // transform would replace it rather than compose with it.
    transform:
      variant === "lift" && expanded
        ? "translateY(calc(-50% - 5px))"
        : "translateY(-50%)",
    // Overshoot only on `lift`; the rest settle, because a surface that is on
    // screen all day should not bounce every time the pointer crosses it.
    transitionTimingFunction:
      variant === "lift"
        ? "cubic-bezier(.2,1.5,.4,1)"
        : "cubic-bezier(.2,.8,.2,1)",
    ["--accent" as string]: ACCENT,
  };

  return (
    <div
      className="absolute top-1/2 flex h-11 items-center rounded-full border border-white/15 bg-black/35 backdrop-blur-xl transition-[width,margin-left,transform] duration-300 will-change-[width,transform]"
      style={style}
    >
      <Avatar glow={glow && !expanded} />
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

function Avatar({ glow }: { glow: boolean }) {
  return (
    <div className="relative grid size-11 shrink-0 place-items-center">
      {glow && (
        <span
          className="absolute size-11 animate-pulse rounded-full blur-md"
          style={{ background: ACCENT, opacity: 0.45 }}
          aria-hidden
        />
      )}
      {/* Stand-in for the assistant's avatar. The real one is an image at the
          same 28px, so nothing about the geometry changes when it lands. */}
      <span
        className="relative size-7 rounded-full"
        style={{
          background: `radial-gradient(circle at 32% 30%, #fff 0%, ${ACCENT} 45%, #0f766e 100%)`,
        }}
        aria-hidden
      />
    </div>
  );
}

/** Hover, with the app idle: the two ways in. */
function IdleBody() {
  return (
    <>
      <PillButton icon={<AudioLines className="size-4" />} label="Talk" />
      <PillButton icon={<MessageSquareText className="size-4" />} label="Ask" />
    </>
  );
}

/** Hover, mid-call: the session's own controls, at pill scale. */
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
      <PillButton icon={<Mic className="size-4" />} label="" />
      <PillButton icon={<Volume2 className="size-4" />} label="" />
      <PillButton
        icon={<X className="size-4" strokeWidth={2.5} />}
        label=""
        tone="negative"
      />
    </>
  );
}

function PillButton({
  icon,
  label,
  tone,
}: {
  icon: ReactNode;
  label: string;
  tone?: "negative";
}) {
  return (
    <button
      type="button"
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors hover:bg-white/15 ${
        tone === "negative" ? "text-[#ff6b6b]" : "text-white/85"
      }`}
    >
      {icon}
      {label !== "" && <span>{label}</span>}
    </button>
  );
}
