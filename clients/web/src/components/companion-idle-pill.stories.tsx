import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { CompanionSurface } from "@/components/companion-surface";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import {
  COMPANION_BASE_AVATAR_IMAGE,
  COMPANION_BASE_MAX_PILL_WIDTH,
  type CompanionCharacter,
} from "@vellumai/ipc-contract";

/**
 * A bench for the idle companion, not the idle companion.
 *
 * Today the surface at rest is a 10pt capsule in the assistant's colour
 * (`CompanionSurface`, phase `resting`): a marker that asks for nothing and,
 * on a busy desktop, is close to nothing to find. The alternative on the table
 * is the shape Wispr Flow rests in: a pill that is genuinely a pill, wider than
 * it is tall, semi opaque rather than solid, and legible because its edge is
 * lit rather than because its fill is dark.
 *
 * That is two questions, and they are both dials rather than opinions: **how
 * wide** the resting pill wants to be, and **what its edge does**. So both are
 * controls here, and every rim is drawn from the same fill and the same
 * creature so the only difference between two of them is the edge.
 *
 * Nothing in this file is imported by the app. It is a stories file so the
 * candidates can be looked at, argued about and thrown away without a
 * production component existing for a shape nobody has picked yet. When one
 * wins, it moves into `companion-surface.tsx` as the resting phase and this
 * file goes.
 */

/** The desktop the pill floats over, which is what decides whether it reads. */
const BACKDROPS = {
  dark: "linear-gradient(140deg, #14161a 0%, #1d2026 55%, #0f1113 100%)",
  light: "linear-gradient(140deg, #f4f1ec 0%, #e6e9ef 55%, #dfe3ea 100%)",
  busy: "linear-gradient(120deg, #4c1d95 0%, #b91c1c 28%, #047857 58%, #1d4ed8 82%, #f59e0b 100%)",
  photo:
    "radial-gradient(120% 90% at 20% 10%, #cbd5e1 0%, transparent 55%), radial-gradient(90% 80% at 85% 75%, #0f766e 0%, transparent 60%), linear-gradient(160deg, #1e293b 0%, #475569 45%, #94a3b8 100%)",
};

type Backdrop = keyof typeof BACKDROPS;

/** The creature in the pill, live rather than a still, so it blinks in place. */
const EXAMPLE_CHARACTER: CompanionCharacter = {
  bodyShape: "burst",
  eyeStyle: "curious",
  color: "teal",
};

/**
 * The edge treatments on trial.
 *
 * Ordered by how much they ask for: today's hairline first, then the ones that
 * light up, then the ones that move. A rim that moves at rest is the loudest
 * thing this surface could do all day, so those are last on purpose and are
 * here to be ruled out as much as ruled in.
 */
const RIMS = {
  /** What the pill draws today: one hairline, no light. The control group. */
  hairline: "Hairline (today)",
  /** One lit line in the accent, with a bloom tight enough to stay a line. */
  lit: "Lit line",
  /** No line at all. The pill is found by the light it throws, not its edge. */
  halo: "Halo, no line",
  /** A top highlight and a bottom shade: a macOS glass lozenge, colourless. */
  bezel: "Glass bezel",
  /** Bright at the top, fading down: an edge catching a light above it. */
  gradient: "Lit from above",
  /** Two lines, an outer dark and an inner bright: a device bezel. */
  double: "Double rim",
  /** The accent line, brightening and dimming on a slow breath. */
  breathe: "Breathing",
  /** A highlight travelling the edge, slowed from the working ring's orbit. */
  orbit: "Travelling light",
  /** A sweep crossing the rim left to right, the way a sheen crosses glass. */
  sheen: "Sheen",
} as const;

type Rim = keyof typeof RIMS;

/** What sits in the pill, since a wide pill's width is a question about it. */
const CONTENTS = {
  /** The creature alone, centred. The emptiest a wide pill can be. */
  creature: "Creature only",
  /** The creature at the leading edge and the way in spelled out beside it. */
  hint: "Creature and hint",
  /** The creature and a resting level meter, the shape Wispr rests in. */
  bars: "Creature and levels",
} as const;

type Content = keyof typeof CONTENTS;

/**
 * The lab's own stylesheet, injected by the pill rather than added to
 * `index.css`.
 *
 * These classes exist to be deleted along with this file. Putting them in the
 * app's global sheet would outlive the experiment, and the shipped sheet is
 * where the surviving rim belongs, once there is one.
 */
const LAB_CSS = `
.idle-lab-rim {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: var(--idle-lab-rim-width, 1px);
  pointer-events: none;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}

/* Brightest along the top edge and gone by the bottom, so the pill reads as a
   solid object under a light rather than a shape someone outlined. */
.idle-lab-rim-gradient {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--idle-lab-accent) 40%, #ffffff) 0%,
    color-mix(in srgb, var(--idle-lab-accent) 62%, transparent) 45%,
    color-mix(in srgb, var(--idle-lab-accent) 8%, transparent) 100%
  );
  filter: drop-shadow(
    0 0 calc(4px * var(--idle-lab-glow)) color-mix(in srgb, var(--idle-lab-accent) 50%, transparent)
  );
}

/* Slow enough to be noticed only by someone already looking at it. An idle
   surface that pulses at a readable rate is asking for attention it has no
   news to justify. */
@keyframes idle-lab-breathe {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.idle-lab-rim-breathe {
  background: color-mix(in srgb, var(--idle-lab-accent) 80%, transparent);
  filter: drop-shadow(
    0 0 calc(5px * var(--idle-lab-glow)) color-mix(in srgb, var(--idle-lab-accent) 55%, transparent)
  );
  animation: idle-lab-breathe 4s ease-in-out infinite;
}

@keyframes idle-lab-sheen {
  to { background-position: -200% 0; }
}

.idle-lab-rim-sheen {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--idle-lab-accent) 22%, transparent) 0%,
    color-mix(in srgb, var(--idle-lab-accent) 22%, transparent) 38%,
    color-mix(in srgb, var(--idle-lab-accent) 30%, #ffffff) 50%,
    color-mix(in srgb, var(--idle-lab-accent) 22%, transparent) 62%,
    color-mix(in srgb, var(--idle-lab-accent) 22%, transparent) 100%
  );
  background-size: 200% 100%;
  filter: drop-shadow(
    0 0 calc(4px * var(--idle-lab-glow)) color-mix(in srgb, var(--idle-lab-accent) 45%, transparent)
  );
  animation: idle-lab-sheen 3.4s linear infinite;
}

/* Held lit rather than held still: the rim is what makes the pill findable, so
   a reader who asked for stillness keeps the light and loses the travel. */
@media (prefers-reduced-motion: reduce) {
  .idle-lab-rim-breathe,
  .idle-lab-rim-sheen {
    animation: none;
    opacity: 1;
  }
}
`;

/**
 * The shadow list for the rims that are drawn entirely in `box-shadow`.
 *
 * `glow` scales the bloom's radius rather than its colour, because a bloom
 * that grows by getting more opaque turns into a second fill, and what is
 * being tuned here is how far the light reaches.
 *
 * The rims that need a gradient are absent: a `box-shadow` cannot be brighter
 * at the top than the bottom, so those are drawn as a masked layer instead and
 * take only the drop shadow that holds every one of them off the desktop.
 */
const DROP = "0 8px 24px rgba(0, 0, 0, 0.45)";

function shadowFor(
  rim: Rim,
  accent: string,
  glow: number,
  rimWidth: number,
): string {
  const bloom = (px: number, pct: number) =>
    `0 0 ${(px * glow).toFixed(1)}px color-mix(in srgb, ${accent} ${pct}%, transparent)`;
  const w = `${rimWidth}px`;
  switch (rim) {
    case "hairline":
      return `inset 0 0 0 ${w} rgba(255, 255, 255, 0.1), ${DROP}`;
    case "lit":
      return [
        `inset 0 0 0 ${w} color-mix(in srgb, ${accent} 78%, transparent)`,
        bloom(4, 85),
        bloom(16, 42),
        DROP,
      ].join(", ");
    case "halo":
      return [
        "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
        bloom(12, 45),
        bloom(28, 26),
        DROP,
      ].join(", ");
    case "bezel":
      return [
        `inset 0 ${w} 0 rgba(255, 255, 255, 0.3)`,
        "inset 0 0 0 1px rgba(255, 255, 255, 0.12)",
        `inset 0 -${w} 0 rgba(0, 0, 0, 0.45)`,
        DROP,
      ].join(", ");
    case "double":
      return [
        `inset 0 0 0 ${w} rgba(255, 255, 255, 0.2)`,
        "0 0 0 1px rgba(0, 0, 0, 0.55)",
        bloom(14, 28),
        DROP,
      ].join(", ");
    default:
      // The layered rims bring their own line. All they want from the box is
      // to be held off the desktop.
      return DROP;
  }
}

/** Which rims are drawn as a masked layer over the fill rather than on it. */
const RIM_LAYER: Partial<Record<Rim, string>> = {
  gradient: "idle-lab-rim idle-lab-rim-gradient",
  breathe: "idle-lab-rim idle-lab-rim-breathe",
  sheen: "idle-lab-rim idle-lab-rim-sheen",
};

/**
 * Not exported, and neither is the component: Storybook's indexer reads every
 * export of a stories file as a story, so exporting the thing the stories are
 * about adds a broken ninth entry to the sidebar.
 */
interface IdlePillProps {
  rim: Rim;
  /** The pill's whole width in base units, the way the surface measures. */
  width: number;
  height: number;
  /** Clamped to a true capsule, so a high value means "as round as it goes". */
  radius: number;
  /** The fill's opacity as a percentage. The point of the exercise: not 100. */
  fill: number;
  /** How much desktop the fill blurs behind it, in pixels. */
  blur: number;
  /** How far the rim's light reaches. 0 puts every rim back to a flat line. */
  glow: number;
  /**
   * How thick the rim's line is, in pixels.
   *
   * The dial the comparison with Wispr Flow actually turns on. Their pill is
   * legible over anything at a fill this transparent because its edge is a
   * band rather than a hairline, and a hairline is what every macOS surface
   * defaults to.
   */
  rimWidth: number;
  accentHex: string;
  content: Content;
}

/**
 * One candidate resting pill.
 *
 * Three layers over the same box: the fill, the rim, and the row. The rim is
 * its own layer rather than a border on the fill because a border is inside
 * the element's box and `backdrop-filter` blurs the whole box, border included,
 * which turns a 1px lit line into a 1px smear of the desktop behind it.
 */
function IdlePill({
  rim,
  width,
  height,
  radius,
  fill,
  blur,
  glow,
  rimWidth,
  accentHex,
  content,
}: IdlePillProps) {
  const capsule = Math.min(radius, height / 2);
  // The creature keeps its own size until the pill is too short to hold it,
  // so shortening the pill is a statement about the pill and not about who is
  // standing in it.
  const avatar = Math.min(COMPANION_BASE_AVATAR_IMAGE, height - 8);
  const layer = RIM_LAYER[rim];

  return (
    <div
      className="relative flex shrink-0 items-center"
      style={{
        width,
        height,
        borderRadius: capsule,
        paddingInline: 8,
        gap: 8,
        justifyContent: content === "creature" ? "center" : "flex-start",
        boxShadow: shadowFor(rim, accentHex, glow, rimWidth),
        background: `rgba(23, 24, 27, ${(fill / 100).toFixed(2)})`,
        backdropFilter: blur > 0 ? `blur(${blur}px) saturate(1.4)` : undefined,
        ["--idle-lab-accent" as string]: accentHex,
        ["--idle-lab-glow" as string]: glow,
        ["--idle-lab-rim-width" as string]: `${rimWidth}px`,
      }}
    >
      <style>{LAB_CSS}</style>
      {layer !== undefined && <span className={layer} aria-hidden />}
      {rim === "orbit" && (
        // The working ring, at rest and slowed to a third of its speed. Same
        // light the surface already burns for a turn, which is the argument
        // against it as well as for it: an idle pill wearing the working
        // ring's own motion has spent the signal that says a turn is running.
        <span
          className="companion-working-ring pointer-events-none absolute"
          style={{
            inset: -rimWidth,
            padding: rimWidth,
            borderRadius: "inherit",
            animationDuration: "7.2s",
            ["--companion-ring-accent" as string]: accentHex,
          }}
          aria-hidden
        />
      )}
      <div
        className="relative shrink-0 drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]"
        style={{ width: avatar, height: avatar }}
      >
        <AnimatedAvatar
          components={BUNDLED_COMPONENTS}
          traits={EXAMPLE_CHARACTER}
          size={avatar}
        />
      </div>
      {content === "hint" && (
        <span className="truncate text-[12px] font-medium text-white/70">
          Hold Fn to talk
        </span>
      )}
      {content === "bars" && <RestingLevels accentHex={accentHex} />}
    </div>
  );
}

/**
 * A level meter with nothing to meter: the shape a voice pill rests in.
 *
 * Flat and dim on purpose. What is being judged is whether a wide pill has
 * anything to be wide for, and a bar row that animates at rest would answer
 * that question by cheating.
 */
function RestingLevels({ accentHex }: { accentHex: string }) {
  const heights = [4, 8, 5, 11, 7, 4, 9, 6, 3, 8, 5, 4];
  return (
    <div className="flex flex-1 items-center justify-center gap-[3px]">
      {heights.map((h, index) => (
        <span
          key={index}
          className="w-[2px] rounded-full"
          style={{
            height: h,
            background: `color-mix(in srgb, ${accentHex} 55%, transparent)`,
          }}
          aria-hidden
        />
      ))}
    </div>
  );
}

/**
 * A caption for the gallery stories, which are grids of unlabelled shapes.
 *
 * On its own dark chip rather than as bare text, because these galleries are
 * drawn on whichever desktop the controls are set to and a caption in white
 * disappears into the light one.
 */
function Note({ children }: { children: string }) {
  return (
    <span className="w-fit rounded bg-black/40 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-white/75 uppercase">
      {children}
    </span>
  );
}

type LabArgs = IdlePillProps & { backdrop: Backdrop };

const backdropStage: Decorator = (Story, context) => {
  // A story that paints its own desktop opts out rather than being wrapped in
  // a second one. Decorators compose instead of replacing, so a gallery laid
  // out against the viewport would otherwise render inside this 620pt box and
  // spill out of it.
  if (context.parameters.layout === "fullscreen") {
    return <Story />;
  }
  // Read one field rather than casting the whole bag: Storybook hands a
  // decorator its args as an index signature of `unknown`, which is not the
  // story's own type and does not pretend to be.
  const backdrop = (context.args.backdrop as Backdrop | undefined) ?? "dark";
  return (
    <div
      className="relative grid min-h-[320px] w-[620px] place-items-center overflow-visible rounded-xl p-10"
      style={{ background: BACKDROPS[backdrop] }}
    >
      <Story />
    </div>
  );
};

const meta: Meta<LabArgs> = {
  title: "Components/CompanionSurface/Idle pill lab",
  component: IdlePill,
  parameters: { layout: "centered" },
  argTypes: {
    rim: { control: "select", options: Object.keys(RIMS), labels: RIMS },
    content: {
      control: "inline-radio",
      options: Object.keys(CONTENTS),
      labels: CONTENTS,
    },
    backdrop: {
      control: "inline-radio",
      options: Object.keys(BACKDROPS),
    },
    width: {
      control: {
        type: "range",
        min: 44,
        max: COMPANION_BASE_MAX_PILL_WIDTH,
        step: 2,
      },
    },
    height: { control: { type: "range", min: 24, max: 56, step: 1 } },
    radius: { control: { type: "range", min: 4, max: 28, step: 1 } },
    fill: { control: { type: "range", min: 0, max: 100, step: 1 } },
    blur: { control: { type: "range", min: 0, max: 24, step: 1 } },
    glow: { control: { type: "range", min: 0, max: 2.5, step: 0.1 } },
    rimWidth: { control: { type: "range", min: 0.5, max: 4, step: 0.5 } },
    accentHex: { control: "color" },
  },
  args: {
    rim: "lit",
    // Wider than tall by about four to one, which is where the shape stops
    // reading as a lozenge and starts reading as a bar with room in it.
    width: 156,
    // Shorter than the 44 the open pill draws. The open pill is tall because
    // it carries 28pt controls; a resting one carries nobody.
    height: 34,
    radius: 28,
    // Semi opaque and no lower. Below about 60 the desktop reads through the
    // creature, and the fill stops being a surface the pill sits on.
    fill: 72,
    blur: 12,
    glow: 1.4,
    // Thicker than the hairline every other macOS surface draws, which is the
    // proposition being tested rather than a taste applied to it.
    rimWidth: 1.5,
    accentHex: "#5EEAD4",
    content: "creature",
    backdrop: "busy",
  },
  decorators: [backdropStage],
};

export default meta;

type Story = StoryObj<LabArgs>;

/**
 * One pill, every dial.
 *
 * The story to open first. Width and height are ranges rather than presets
 * because the answer is somewhere on a line and not in a list, and `fill`,
 * `blur` and `glow` are the three that decide whether a semi opaque pill is
 * still legible over the busy desktop it defaults to.
 */
export const Playground: Story = {};

/**
 * Every rim at once, on the same fill, width and creature.
 *
 * The only difference between any two of these is the edge, which is the
 * comparison the question actually needs. Change any dial in the controls and
 * all nine move together.
 */
export const EveryRim: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div
      className="min-h-[100vh] p-14"
      style={{ background: BACKDROPS[args.backdrop] }}
    >
      <div className="grid w-fit grid-cols-2 content-start items-start gap-x-16 gap-y-6">
        {(Object.keys(RIMS) as Rim[]).map((rim) => (
          <div key={rim} className="flex flex-col gap-2">
            <Note>{RIMS[rim]}</Note>
            <IdlePill {...args} rim={rim} />
          </div>
        ))}
      </div>
    </div>
  ),
};

/**
 * The chosen rim at seven widths, from today's marker to the widest the canvas
 * allows.
 *
 * Width is the half of this question that has no right answer in isolation: a
 * pill is wide enough when it reads as a pill and not so wide that it is a
 * bar sitting on someone's work. Stacked rather than side by side so the eye
 * compares the left edges.
 */
export const WidthLadder: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div
      className="flex min-h-[100vh] flex-col items-start gap-5 p-14"
      style={{ background: BACKDROPS[args.backdrop] }}
    >
      {[44, 72, 104, 136, 168, 220, 280].map((width) => (
        <div key={width} className="flex items-center gap-4">
          <IdlePill {...args} width={width} />
          <Note>{`${width}pt`}</Note>
        </div>
      ))}
    </div>
  ),
};

/**
 * The chosen rim at every thickness, from a hairline to a band.
 *
 * The other half of what makes an opaque-ish pill readable. Wispr Flow's edge
 * is thick enough to survive a busy desktop at a fill you can see through, and
 * where between 0.5 and 4 that stops being an edge and starts being a frame is
 * the thing to look at here.
 */
export const RimWidthLadder: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div
      className="flex min-h-[100vh] flex-col items-start gap-5 p-14"
      style={{ background: BACKDROPS[args.backdrop] }}
    >
      {[0.5, 1, 1.5, 2, 3, 4].map((rimWidth) => (
        <div key={rimWidth} className="flex items-center gap-4">
          <IdlePill {...args} rimWidth={rimWidth} />
          <Note>{`${rimWidth}px`}</Note>
        </div>
      ))}
    </div>
  ),
};

/**
 * The same pill on all four desktops.
 *
 * A semi opaque fill is a bet on what is behind it, and the bet is lost on the
 * light desktop first: a dark pill over a pale document is legible whatever
 * its edge does, and the lit rim it was given for the busy desktop can read as
 * a glare there instead.
 */
export const OnEveryDesktop: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div className="grid min-h-[100vh] grid-cols-2 grid-rows-2">
      {(Object.keys(BACKDROPS) as Backdrop[]).map((backdrop) => (
        <div
          key={backdrop}
          className="flex min-h-[240px] flex-col items-center justify-center gap-3"
          style={{ background: BACKDROPS[backdrop] }}
        >
          <IdlePill {...args} />
          <Note>{backdrop}</Note>
        </div>
      ))}
    </div>
  ),
};

/**
 * The candidate beside what ships today.
 *
 * The real `CompanionSurface` at rest, on the same desktop and at the same
 * scale, because every one of these rims looks like an improvement until it is
 * put next to the thing it would replace. What the capsule has and none of
 * these do is that it asks for nothing; what it lacks is that on the busy
 * desktop it is a smudge.
 */
export const BesideTodaysCapsule: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div
      className="flex min-h-[100vh] flex-col items-start gap-10 p-14"
      style={{ background: BACKDROPS[args.backdrop] }}
    >
      <div className="flex flex-col gap-3">
        <Note>Today: the resting capsule</Note>
        <div className="relative h-11 w-11">
          <CompanionSurface
            phase="resting"
            character={EXAMPLE_CHARACTER}
            accentHex={args.accentHex}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Note>Candidate</Note>
        <IdlePill {...args} />
      </div>
    </div>
  ),
};

/**
 * What a wide pill could be carrying, at the width the controls are set to.
 *
 * Width and contents are one question asked twice. A pill wide enough to hold
 * a hint is a pill that has to have something to say all day, and a pill
 * holding a flat level meter is claiming to be listening when it is not.
 */
export const EveryContent: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div
      className="flex min-h-[100vh] flex-col items-start gap-6 p-14"
      style={{ background: BACKDROPS[args.backdrop] }}
    >
      {(Object.keys(CONTENTS) as Content[]).map((content) => (
        <div key={content} className="flex flex-col gap-2">
          <Note>{CONTENTS[content]}</Note>
          <IdlePill {...args} content={content} />
        </div>
      ))}
    </div>
  ),
};
