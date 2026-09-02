import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  CompanionPeek,
  PEEK_EDGES,
  PEEK_INTERVAL_SECONDS,
  type PeekEdge,
} from "@/components/companion-peek";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The peek on its own, over a stand-in capsule, for every creature at once.
 *
 * The surface's own story (`CompanionSurface/RestingPeeks`) shows the real
 * thing at real size, firing on its real clock, which is the right way to judge
 * whether it belongs on a desktop. It is the wrong way to compare creatures:
 * a random clock never puts two of them up at once. So this file draws the
 * peek zoomed, held up or on a fast clock, one capsule per body shape.
 *
 * The capsule here is a stand-in drawn to the surface's numbers (28 by 10),
 * not the surface's own. The peek is what is under review, and the surface's
 * capsule cannot be mounted without the surface.
 */

/** The capsule the surface draws at rest, by its numbers. */
const CAPSULE = { width: 28, height: 10 };

const BACKDROPS = {
  dark: "linear-gradient(140deg, #14161a 0%, #1d2026 55%, #0f1113 100%)",
  light: "linear-gradient(140deg, #f4f1ec 0%, #e6e9ef 55%, #dfe3ea 100%)",
  busy: "linear-gradient(120deg, #4c1d95 0%, #b91c1c 28%, #047857 58%, #1d4ed8 82%, #f59e0b 100%)",
};

interface StoryArgs {
  /** Up, no clock: for looking at the creatures. */
  held: boolean;
  /** How much bigger than life the capsules are drawn. */
  zoom: number;
  /** Which eyes every creature wears. */
  eyeStyle: string;
  /** Which edge to come out of, or a fresh draw each peek. */
  edge: PeekEdge | "random";
  /** The clock, in seconds, when not held. Fast by default so it can be watched. */
  minSeconds: number;
  maxSeconds: number;
  backdrop: keyof typeof BACKDROPS;
}

/**
 * One creature's capsule with the creature peeking over it, drawn at the
 * zoom.
 *
 * The peek clips itself at the capsule's edge, so its order against the
 * capsule does not matter; it follows the capsule as it does on the surface.
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
  const stage = 44 * args.zoom;
  const color =
    BUNDLED_COMPONENTS.colors.find((c) => c.hex === accentHex)?.id ?? "teal";
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="relative grid place-items-center rounded-lg bg-white/5"
        style={{ width: stage, height: stage }}
      >
        <div
          className="relative size-11"
          style={{ transform: `scale(${args.zoom})` }}
        >
          <div
            className="absolute top-1/2 left-1/2 rounded-full shadow-lg shadow-black/40"
            style={{
              width: CAPSULE.width,
              height: CAPSULE.height,
              transform: "translate(-50%, -50%)",
              background: accentHex,
            }}
            aria-hidden
          />
          <CompanionPeek
            character={{ bodyShape, eyeStyle: args.eyeStyle, color }}
            capsule={CAPSULE}
            enabled
            held={args.held}
            edge={args.edge === "random" ? undefined : args.edge}
            interval={{ min: args.minSeconds, max: args.maxSeconds }}
            className="absolute top-1/2 left-1/2"
            style={{ transform: "translate(-50%, -50%)" }}
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
  title: "Components/CompanionPeek",
  render: (args) => <Gallery {...args} />,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    held: { control: "boolean" },
    zoom: { control: { type: "range", min: 1, max: 6, step: 1 } },
    eyeStyle: {
      control: "select",
      options: BUNDLED_COMPONENTS.eyeStyles.map((eyes) => eyes.id),
    },
    edge: { control: "inline-radio", options: ["random", ...PEEK_EDGES] },
    minSeconds: { control: { type: "number", min: 0.5, step: 0.5 } },
    maxSeconds: { control: { type: "number", min: 0.5, step: 0.5 } },
    backdrop: {
      control: "inline-radio",
      options: Object.keys(BACKDROPS),
    },
  },
  args: {
    held: false,
    zoom: 4,
    eyeStyle: "curious",
    edge: "random",
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
 * What ships, held up over the top: every creature looking out at once. The
 * place to judge whether each one's eyes clear the rim.
 */
export const Held: Story = {
  args: { held: true, edge: "top" },
};

/** Hanging upside down off the bottom rim, as the chat page's hello does. */
export const HeldBelow: Story = {
  args: { held: true, edge: "bottom" },
};

/** The surface's real clock, at life size, on the busiest backdrop. */
export const LifeSize: Story = {
  args: {
    zoom: 1,
    minSeconds: PEEK_INTERVAL_SECONDS.min,
    maxSeconds: PEEK_INTERVAL_SECONDS.max,
    backdrop: "busy",
  },
};

/** The light desktop, where the shadow is doing the work. */
export const OnALightDesktop: Story = {
  args: { held: true, backdrop: "light" },
};
