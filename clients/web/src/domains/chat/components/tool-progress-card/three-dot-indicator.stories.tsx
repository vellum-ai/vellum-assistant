import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThreeDotIndicator } from "./three-dot-indicator";

/**
 * `ThreeDotIndicator` is the single, shared "loading dots" used everywhere the
 * app shows in-flight tool/agent work: the tool-progress card header, each
 * running phase node in the expanded timeline, the web-search card, and the
 * `SingleActivity`. Three dots pulse in a staggered left-to-right wave and
 * honour `prefers-reduced-motion`.
 */
const meta: Meta<typeof ThreeDotIndicator> = {
  title: "Chat/ThreeDotIndicator",
  component: ThreeDotIndicator,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    dotSize: {
      control: { type: "number", min: 2, max: 24, step: 1 },
      description: "Diameter of each dot in px.",
    },
    gap: {
      control: { type: "number", min: 0, max: 16, step: 1 },
      description: "Spacing between dots in px.",
    },
  },
};

export default meta;
type Story = StoryObj<typeof ThreeDotIndicator>;

/** Default transcript sizing — 8px dots with a 3px gap. */
export const Default: Story = {};

/** Tighter sizing used in cramped contexts like the avatar progress badge. */
export const Small: Story = {
  args: {
    dotSize: 5,
    gap: 2,
  },
};

/** Larger sizing to inspect the pulse/scale animation closely. */
export const Large: Story = {
  args: {
    dotSize: 14,
    gap: 6,
  },
};

/** Sat against a card-like surface, mirroring its in-app placement. */
export const OnSurface: Story = {
  decorators: [
    (Story) => (
      <div className="flex items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--surface-overlay)] p-3">
        <Story />
        <span className="text-body-medium-default text-[var(--content-emphasised)]">
          Working for 6s
        </span>
      </div>
    ),
  ],
};
