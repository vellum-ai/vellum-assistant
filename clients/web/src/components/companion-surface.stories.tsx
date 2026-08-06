import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ChangeEvent } from "react";

import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { composeSvg } from "@/utils/avatar-svg-compositor";

/**
 * A real assistant avatar, composed from the same bundled character components
 * the hatching screen uses, so what is on the pill is a genuine avatar rather
 * than a stand-in that happens to be round. Composed once at module scope: it
 * is a pure function of constants.
 */
const EXAMPLE_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  composeSvg(BUNDLED_COMPONENTS, "burst", "curious", "teal", 128),
)}`;

/**
 * The surface floats over other applications, so every story sits on a
 * stand-in desktop rather than the Storybook canvas. What is behind it is the
 * variable that decides whether the pill is readable, which is why it is a
 * control rather than a fixed backdrop.
 */
const BACKDROPS = {
  dark: "linear-gradient(140deg, #14161a 0%, #1d2026 55%, #0f1113 100%)",
  light: "linear-gradient(140deg, #f4f1ec 0%, #e6e9ef 55%, #dfe3ea 100%)",
  busy: "linear-gradient(120deg, #4c1d95 0%, #b91c1c 28%, #047857 58%, #1d4ed8 82%, #f59e0b 100%)",
};

type Backdrop = keyof typeof BACKDROPS;

type StoryArgs = React.ComponentProps<typeof CompanionSurface> & {
  backdrop: Backdrop;
};

const meta: Meta<StoryArgs> = {
  title: "Components/CompanionSurface",
  component: CompanionSurface,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    phase: {
      control: "inline-radio",
      options: ["resting", "hover", "call"],
    },
    backdrop: {
      control: "inline-radio",
      options: ["dark", "light", "busy"],
    },
    anchor: {
      control: "inline-radio",
      options: ["center", "left", "right"],
    },
    accentHex: { control: "color" },
    glow: { control: "boolean" },
  },
  args: {
    phase: "resting",
    glow: true,
    backdrop: "dark",
    avatarSrc: EXAMPLE_AVATAR,
  },
  decorators: [
    (Story, context) => (
      <div
        className="relative h-[180px] w-[520px] overflow-hidden rounded-xl"
        style={{
          background: BACKDROPS[(context.args as StoryArgs).backdrop ?? "dark"],
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<StoryArgs>;

/** The circle, as it sits when nobody is asking anything of it. */
export const Resting: Story = {
  args: { phase: "resting" },
};

/** Expanded with the app idle: the two ways in. */
export const Hover: Story = {
  args: { phase: "hover" },
};

/** Expanded mid-call: the session's own controls, at pill scale. */
export const InCall: Story = {
  args: { phase: "call" },
};

/**
 * The open contrast question, pinned as its own story so it cannot be lost in
 * a control. The pill assumes a dark desktop, and white on a 35% black scrim
 * stops being readable over a pale one.
 */
export const OnALightDesktop: Story = {
  args: { phase: "call", backdrop: "light" },
};

/**
 * The circle parked hard against a screen edge, where bloom cannot bloom.
 *
 * It wants 72px of clearance either side expanded and 126px in a call, and
 * there is none to the left, so `anchor: "left"` pins that edge and grows the
 * body rightward instead. The avatar stays exactly where the user put it.
 *
 * **Set `anchor` to `center` to see why this exists.** Unclamped, the pill
 * grows straight past the edge and takes the avatar with it, so the surface
 * disappears off the side of the screen at the moment it is reached for.
 */
export const AgainstTheLeftEdge: Story = {
  args: { phase: "hover", anchor: "left" },
  decorators: [
    (Story) => (
      // A 44px column at the stage's left edge: the avatar's own footprint,
      // with the screen ending immediately to its left.
      <div className="absolute top-0 left-0 h-full w-11">
        <Story />
      </div>
    ),
  ],
};

/** The mirror case, where the body has to grow leftward instead. */
export const AgainstTheRightEdge: Story = {
  args: { phase: "call", anchor: "right" },
  decorators: [
    (Story) => (
      <div className="absolute top-0 right-0 h-full w-11">
        <Story />
      </div>
    ),
  ],
};

/**
 * The move itself, which is the thing being designed and the one thing a
 * static story cannot show. Expansion arms on the avatar alone, so the rest of
 * the desktop is dead space exactly as it is in the real window.
 *
 * Drop in an image to see the surface wearing a particular assistant. It never
 * leaves the browser: the file is read to a data URL and handed straight to the
 * component, which is also the shape the Electron payload arrives in.
 */
export const Interactive: Story = {
  args: { phase: "resting" },
  render: (args) => <HoverDrivenSurface {...args} />,
};

/**
 * Hover state lives in a component rather than in `render`, which is not one
 * and so may not hold hooks. The `phase` arg still wins when it is `call`, so
 * the control can pin the call state and hover keeps driving the idle one.
 */
function HoverDrivenSurface(args: StoryArgs) {
  const [hovered, setHovered] = useState(false);
  const [uploaded, setUploaded] = useState<string | undefined>();

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setUploaded(
        typeof reader.result === "string" ? reader.result : undefined,
      );
    };
    reader.readAsDataURL(file);
  };

  const phase: CompanionSurfacePhase =
    args.phase === "call" ? "call" : hovered ? "hover" : "resting";

  return (
    <>
      <CompanionSurface
        {...args}
        phase={phase}
        avatarSrc={uploaded ?? args.avatarSrc}
        onHoverStart={() => {
          setHovered(true);
        }}
        onHoverEnd={() => {
          setHovered(false);
        }}
      />
      <label className="absolute bottom-2 left-2 cursor-pointer rounded-md bg-black/50 px-2 py-1 text-[11px] text-white/80 backdrop-blur-sm">
        Use my own avatar
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFile}
        />
      </label>
      {uploaded !== undefined && (
        <button
          type="button"
          className="absolute bottom-2 left-[132px] rounded-md bg-black/50 px-2 py-1 text-[11px] text-white/80 backdrop-blur-sm"
          onClick={() => {
            setUploaded(undefined);
          }}
        >
          Reset
        </button>
      )}
    </>
  );
}
