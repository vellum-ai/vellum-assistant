import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  BRISTLE_INTERVAL_SECONDS,
  bristleBox,
  bristleFor,
  CompanionBristle,
  type BristleFeature,
} from "@/components/companion-bristle";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The bristle on its own, over a stand-in capsule, for every creature at once.
 *
 * The surface's own story (`CompanionSurface/RestingBristles`) shows the real
 * thing at real size, firing on its real clock, which is the right way to judge
 * whether it belongs on a desktop. It is the wrong way to compare two
 * alternatives: 28 by 10 points is too small to see a petal's outline in, and
 * a random clock never puts two shapes in the same phase. So this file draws
 * the bristle zoomed, held at full stretch or on a fast clock, and offers the
 * alternatives that were weighed as controls: where the features stand and
 * how they move.
 *
 * The capsule here is a stand-in drawn to the surface's numbers (28 by 10,
 * with a 2 point rim), not the surface's own. The bristle is what is under
 * review, and the surface's capsule cannot be mounted without the surface.
 */

/** The capsule the surface draws at rest, by its numbers. */
const CAPSULE = { width: 28, height: 10, rim: 2 };
const RIM_HEX = "#17181b";

const BACKDROPS = {
  dark: "linear-gradient(140deg, #14161a 0%, #1d2026 55%, #0f1113 100%)",
  light: "linear-gradient(140deg, #f4f1ec 0%, #e6e9ef 55%, #dfe3ea 100%)",
  busy: "linear-gradient(120deg, #4c1d95 0%, #b91c1c 28%, #047857 58%, #1d4ed8 82%, #f59e0b 100%)",
};

/**
 * Where the features stand.
 *
 * - `top-heavy`: what ships. Most on top, a few underneath so the capsule does
 *   not read as wearing a crown.
 * - `top-only`: the underneath ones dropped. Cleaner, and the pill hangs off
 *   the capsule's side so nothing below competes with it; but it does read as
 *   a crown, and a ghost with no hem is a dome.
 * - `all-around`: the top set mirrored underneath, a little shorter. Most like
 *   the creature itself for the radial shapes (urchin, burst, flower), and
 *   twice the motion for the same glance.
 */
const PLACEMENTS = ["top-heavy", "top-only", "all-around"] as const;
type Placement = (typeof PLACEMENTS)[number];

const placed = (
  features: readonly BristleFeature[],
  placement: Placement,
): readonly BristleFeature[] => {
  const top = features.filter((feature) => feature.side === "top");
  switch (placement) {
    case "top-heavy":
      return features;
    case "top-only":
      return top;
    case "all-around":
      return [
        ...top,
        ...top.map((feature) => ({
          ...feature,
          side: "bottom" as const,
          reach: feature.reach * 0.8,
          tilt: -(feature.tilt ?? 0),
        })),
      ];
  }
};

/**
 * How the features move.
 *
 * - `twitch`: what ships. Fast out with a little overshoot, a short hold, slow
 *   back. A creature stirring.
 * - `swell`: slower and symmetric, no overshoot. A creature breathing out.
 *   Calmer, and easier to miss.
 * - `ripple`: the twitch with the stagger widened, so the set sweeps across
 *   the capsule rather than rising together. Liveliest, and the most like a
 *   thing happening in the corner of the eye.
 */
const MOTIONS = ["twitch", "swell", "ripple"] as const;
type Motion = (typeof MOTIONS)[number];

/**
 * The alternatives' travel, scoped to this story so `index.css` carries only
 * what ships. Each wrapper class overrides the shipped animation on the
 * features inside it; `twitch` is the shipped one and needs nothing.
 */
const MOTION_STYLES = `
@keyframes story-bristle-swell {
  0% { transform: scaleY(0); }
  45% { transform: scaleY(1); }
  60% { transform: scaleY(1); }
  100% { transform: scaleY(0); }
}
.bristle-motion-swell .companion-bristle-feature {
  animation-name: story-bristle-swell;
  animation-duration: 1600ms;
  animation-timing-function: ease-in-out;
}
.bristle-motion-ripple .companion-bristle-feature {
  --bristle-stagger: 90ms;
}
`;

interface StoryArgs {
  placement: Placement;
  motion: Motion;
  /** Full stretch, no clock: for looking at the shapes. */
  held: boolean;
  /** How much bigger than life the capsules are drawn. */
  zoom: number;
  /** The clock, in seconds, when not held. Fast by default so it can be watched. */
  minSeconds: number;
  maxSeconds: number;
  backdrop: keyof typeof BACKDROPS;
}

/**
 * One creature's capsule with its bristle behind it, drawn at the zoom.
 *
 * The bristle goes first in the DOM so the capsule paints over it, which is the
 * arrangement the surface uses: the bases are hidden under the capsule and the
 * features grow out past its rim.
 */
function Capsule({
  bodyShape,
  accentHex,
  args,
}: {
  bodyShape: string;
  accentHex: string;
  args: StoryArgs;
}) {
  const box = bristleBox(CAPSULE);
  const features = bristleFor(bodyShape);
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`relative grid place-items-center rounded-lg bg-white/5 bristle-motion-${args.motion}`}
        style={{ width: 44 * args.zoom, height: 44 * args.zoom }}
      >
        <div
          className="relative"
          style={{
            width: box.width,
            height: box.height,
            transform: `scale(${args.zoom})`,
          }}
        >
          {features !== undefined ? (
            <CompanionBristle
              bodyShape={bodyShape}
              features={placed(features, args.placement)}
              accentHex={accentHex}
              rimHex={RIM_HEX}
              capsule={CAPSULE}
              enabled
              held={args.held}
              interval={{ min: args.minSeconds, max: args.maxSeconds }}
              className="absolute top-1/2 left-1/2 drop-shadow-[0_1px_3px_rgba(0,0,0,0.4)]"
              style={{ transform: "translate(-50%, -50%)" }}
            />
          ) : null}
          <div
            className="absolute top-1/2 left-1/2 rounded-full shadow-lg shadow-black/40"
            style={{
              width: CAPSULE.width + 2 * CAPSULE.rim,
              height: CAPSULE.height + 2 * CAPSULE.rim,
              transform: "translate(-50%, -50%)",
              background: accentHex,
              border: `${CAPSULE.rim}px solid ${RIM_HEX}`,
            }}
            aria-hidden
          />
        </div>
      </div>
      <span className="text-[11px] text-white/70">{bodyShape}</span>
    </div>
  );
}

/** Every body shape in the catalog, each in a different palette colour. */
function Gallery(args: StoryArgs) {
  return (
    <div
      className="grid grid-cols-5 gap-6 rounded-xl p-6"
      style={{ background: BACKDROPS[args.backdrop] }}
    >
      <style>{MOTION_STYLES}</style>
      {BUNDLED_COMPONENTS.bodyShapes.map((shape, index) => {
        const color =
          BUNDLED_COMPONENTS.colors[index % BUNDLED_COMPONENTS.colors.length];
        return (
          <Capsule
            key={shape.id}
            bodyShape={shape.id}
            accentHex={color?.hex ?? "#5eead4"}
            args={args}
          />
        );
      })}
    </div>
  );
}

const meta: Meta<StoryArgs> = {
  title: "Components/CompanionBristle",
  render: (args) => <Gallery {...args} />,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    placement: { control: "inline-radio", options: PLACEMENTS },
    motion: { control: "inline-radio", options: MOTIONS },
    held: { control: "boolean" },
    zoom: { control: { type: "range", min: 1, max: 6, step: 1 } },
    minSeconds: { control: { type: "number", min: 0.5, step: 0.5 } },
    maxSeconds: { control: { type: "number", min: 0.5, step: 0.5 } },
    backdrop: {
      control: "inline-radio",
      options: Object.keys(BACKDROPS),
    },
  },
  args: {
    placement: "top-heavy",
    motion: "twitch",
    held: false,
    zoom: 4,
    minSeconds: 1,
    maxSeconds: 3,
    backdrop: "dark",
  },
};

export default meta;

type Story = StoryObj<StoryArgs>;

/**
 * What ships, on a clock fast enough to watch. Each capsule draws its own
 * gaps, so they take turns.
 */
export const Live: Story = {};

/**
 * What ships, held at full stretch: every creature's vocabulary in one glance.
 * The place to judge whether a shape's features are the right ones.
 */
export const Held: Story = {
  args: { held: true },
};

/** The surface's real clock, at life size, on the busiest backdrop. */
export const LifeSize: Story = {
  args: {
    zoom: 1,
    minSeconds: BRISTLE_INTERVAL_SECONDS.min,
    maxSeconds: BRISTLE_INTERVAL_SECONDS.max,
    backdrop: "busy",
  },
};

/** Alternative: nothing underneath. See {@link PLACEMENTS}. */
export const TopOnly: Story = {
  args: { placement: "top-only", held: true },
};

/** Alternative: the top set mirrored below. See {@link PLACEMENTS}. */
export const AllAround: Story = {
  args: { placement: "all-around", held: true },
};

/** Alternative: a slow, symmetric swell. See {@link MOTIONS}. */
export const Swell: Story = {
  args: { motion: "swell" },
};

/** Alternative: the stagger widened into a sweep. See {@link MOTIONS}. */
export const Ripple: Story = {
  args: { motion: "ripple" },
};

/** The light desktop, where the rim is doing the work. */
export const OnALightDesktop: Story = {
  args: { held: true, backdrop: "light" },
};
