import type { Meta, StoryObj } from "@storybook/react-vite";

import { ProgressBar } from "./progress-bar";

const meta: Meta<typeof ProgressBar> = {
  title: "Components/ProgressBar",
  component: ProgressBar,
  argTypes: {
    value: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
    height: { control: { type: "number", min: 2, max: 24 } },
    fillColor: { control: { type: "text" } },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ProgressBar>;

export const Default: Story = {
  args: { value: 0.6, "aria-label": "Progress" },
};

export const Empty: Story = {
  args: { value: 0, "aria-label": "Empty progress" },
};

export const Full: Story = {
  args: { value: 1, "aria-label": "Complete" },
};

export const CustomHeight: Story = {
  args: { value: 0.45, height: 12, "aria-label": "Thick progress bar" },
};

/**
 * A threshold gauge, where colour carries meaning that length alone does not.
 * `fillColor` tints the fill; the track is styled with `className`.
 */
export const Tinted: Story = {
  args: {
    value: 0.88,
    height: 16,
    fillColor: "var(--system-negative-strong)",
    className: "bg-[color-mix(in_srgb,var(--content-tertiary)_20%,transparent)]",
    "aria-label": "Context window 88% full",
  },
};

export const Increments: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", width: 320 }}>
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <ProgressBar key={v} value={v} aria-label={`${v * 100}%`} />
      ))}
    </div>
  ),
};
