import { Clock, MessageSquare, TrendingDown, Zap } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { StatSquare } from "./stat-square";

const meta: Meta<typeof StatSquare> = {
  title: "Components/StatSquare",
  component: StatSquare,
  args: {
    icon: <MessageSquare className="h-5 w-5" />,
    value: "1,284",
    label: "Messages this week",
    tone: "default",
  },
  argTypes: {
    tone: {
      control: "inline-radio",
      options: ["default", "negative", "muted"],
    },
    value: { control: "text" },
    label: { control: "text" },
  },
  // StatSquare fills with `--surface-base`; a sunken backdrop makes the card
  // edge visible in isolation.
  decorators: [
    (Story) => (
      <div
        style={{
          background: "var(--surface-sunken)",
          padding: "1.5rem",
          borderRadius: 12,
          width: 420,
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof StatSquare>;

/** Arg-driven: edit value/label and switch tone from the Controls panel. */
export const Default: Story = {};

/** No icon — value and label only. */
export const NoIcon: Story = {
  args: { icon: undefined, value: "98.6%", label: "Uptime" },
};

/** The three tones applied to the value text. */
export const Tones: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <StatSquare
        icon={<Zap />}
        value="42 ms"
        label="Median latency"
        tone="default"
      />
      <StatSquare
        icon={<TrendingDown />}
        value="-12%"
        label="Error rate change"
        tone="negative"
      />
      <StatSquare
        icon={<Clock />}
        value="—"
        label="Last sync (never)"
        tone="muted"
      />
    </div>
  ),
};

/** Squares share a row, each flexing to equal width. */
export const Row: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", gap: "0.75rem" }}>
      <StatSquare icon={<MessageSquare />} value="1,284" label="Messages" />
      <StatSquare icon={<Zap />} value="42 ms" label="Latency" />
    </div>
  ),
};

/**
 * A value longer than the tile, which is what a model id or a long count is.
 * The tile cuts it and the caller passes `title`, so the rest stays readable
 * on hover; the cut never reflows the tile or spills past its edge.
 */
export const LongValue: Story = {
  args: {
    value: "claude-opus-4-1-20250805",
    label: "Model",
    title: "claude-opus-4-1-20250805",
  },
};
