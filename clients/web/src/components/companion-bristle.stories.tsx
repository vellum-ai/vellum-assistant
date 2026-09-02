import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  BRISTLE_INTERVAL_SECONDS,
  BRISTLE_REACH,
  bristleBox,
  CompanionBristle,
} from "@/components/companion-bristle";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The bristle on its own, over a stand-in capsule, for every creature at once.
 *
 * The surface's own story (`CompanionSurface/RestingBristles`) shows the real
 * thing at real size, firing on its real clock, which is the right way to judge
 * whether it belongs on a desktop. It is the wrong way to look at the
 * silhouettes: 28 by 10 points is too small to see a spine's outline in, and a
 * random clock never puts two shapes in the same phase. So this file draws the
 * bristle zoomed, held at full stretch or on a fast clock, beside the artwork
 * it was read from.
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

interface StoryArgs {
  /** Full stretch, no clock: for looking at the silhouettes. */
  held: boolean;
  /** How much bigger than life the capsules are drawn. */
  zoom: number;
  /** How far past the rim the outline may stand. */
  reach: number;
  /** The clock, in seconds, when not held. Fast by default so it can be watched. */
  minSeconds: number;
  maxSeconds: number;
  /** The artwork the silhouette was read from, beside each capsule. */
  showArtwork: boolean;
  backdrop: keyof typeof BACKDROPS;
}

/**
 * One creature's capsule with its bristle behind it, drawn at the zoom, and
 * the artwork it was read from beside it.
 *
 * The bristle goes first in the DOM so the capsule paints over it, which is the
 * arrangement the surface uses: at rest the outline coincides with the
 * capsule's edge under the rim, and grows out past it.
 */
function Capsule({
  bodyShape,
  svgPath,
  viewBox,
  accentHex,
  args,
}: {
  bodyShape: string;
  svgPath: string;
  viewBox: { width: number; height: number };
  accentHex: string;
  args: StoryArgs;
}) {
  const box = bristleBox(CAPSULE, args.reach);
  const stage = 44 * args.zoom;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-2">
        {args.showArtwork ? (
          <svg
            width={stage / 2}
            height={stage / 2}
            viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
            className="opacity-70"
            aria-hidden
          >
            <path d={svgPath} fill={accentHex} />
          </svg>
        ) : null}
        <div
          className="relative grid place-items-center rounded-lg bg-white/5"
          style={{ width: stage, height: stage }}
        >
          <div
            className="relative"
            style={{
              width: box.width,
              height: box.height,
              transform: `scale(${args.zoom})`,
            }}
          >
            <CompanionBristle
              bodyShape={bodyShape}
              accentHex={accentHex}
              rimHex={RIM_HEX}
              capsule={CAPSULE}
              enabled
              held={args.held}
              reach={args.reach}
              interval={{ min: args.minSeconds, max: args.maxSeconds }}
              className="absolute top-1/2 left-1/2 drop-shadow-[0_1px_3px_rgba(0,0,0,0.4)]"
              style={{ transform: "translate(-50%, -50%)" }}
            />
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
            svgPath={shape.svgPath}
            viewBox={shape.viewBox}
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
    held: { control: "boolean" },
    zoom: { control: { type: "range", min: 1, max: 6, step: 1 } },
    reach: { control: { type: "range", min: 2, max: 12, step: 1 } },
    minSeconds: { control: { type: "number", min: 0.5, step: 0.5 } },
    maxSeconds: { control: { type: "number", min: 0.5, step: 0.5 } },
    showArtwork: { control: "boolean" },
    backdrop: {
      control: "inline-radio",
      options: Object.keys(BACKDROPS),
    },
  },
  args: {
    held: false,
    zoom: 4,
    reach: BRISTLE_REACH,
    minSeconds: 1,
    maxSeconds: 3,
    showArtwork: true,
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
 * What ships, held at full stretch: every creature's silhouette in one glance,
 * beside the artwork it was read from. The place to judge whether the pill
 * reads as that creature.
 */
export const Held: Story = {
  args: { held: true },
};

/** The surface's real clock, at life size, on the busiest backdrop. */
export const LifeSize: Story = {
  args: {
    zoom: 1,
    showArtwork: false,
    minSeconds: BRISTLE_INTERVAL_SECONDS.min,
    maxSeconds: BRISTLE_INTERVAL_SECONDS.max,
    backdrop: "busy",
  },
};

/** The light desktop, where the rim is doing the work. */
export const OnALightDesktop: Story = {
  args: { held: true, backdrop: "light" },
};
