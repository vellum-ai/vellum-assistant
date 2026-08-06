import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";

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
    accentHex: { control: "color" },
    glow: { control: "boolean" },
  },
  args: {
    phase: "resting",
    glow: true,
    backdrop: "dark",
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
 * The move itself, which is the thing being designed and the one thing a
 * static story cannot show. Hovering the desktop expands the surface, the same
 * trigger the real window gets from forwarded mouse-move.
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
  const phase: CompanionSurfacePhase =
    args.phase === "call" ? "call" : hovered ? "hover" : "resting";
  return (
    <div
      className="absolute inset-0"
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
    >
      <CompanionSurface {...args} phase={phase} />
    </div>
  );
}
