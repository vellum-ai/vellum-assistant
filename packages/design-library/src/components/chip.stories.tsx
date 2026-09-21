import { ArrowUpCircle, ChevronDown, ExternalLink, Quote } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Chip } from "./chip";

const TONES = ["neutral", "positive", "negative", "warning", "info"] as const;

const meta: Meta<typeof Chip> = {
  title: "Components/Chip",
  component: Chip,
  args: {
    children: "Jump to highlight",
    tone: "neutral",
    disabled: false,
  },
  argTypes: {
    tone: { control: "select", options: TONES },
    children: { control: "text" },
    leftIcon: { control: false },
    rightIcon: { control: false },
    asChild: { control: false },
    ref: { control: false },
  },
};

export default meta;

type Story = StoryObj<typeof Chip>;

/**
 * Arg-driven: a plain action chip. Edit the label or flip the tone from the
 * Controls panel. Hover, press and Tab to it for the interactive states.
 */
export const Default: Story = {};

/** Every tone at a glance. */
export const Tones: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
      {TONES.map((tone) => (
        <Chip key={tone} tone={tone}>
          {tone}
        </Chip>
      ))}
    </div>
  ),
};

/** The leading icon takes the tone's accent; the trailing one stays quiet. */
export const WithIcons: Story = {
  args: {
    tone: "warning",
    leftIcon: <ArrowUpCircle />,
    rightIcon: <ChevronDown />,
    children: "Update available",
  },
};

/** Disabled keeps its place in the layout and drops the hover wash. */
export const Disabled: Story = {
  args: { disabled: true, leftIcon: <Quote />, children: "Unavailable" },
};

/**
 * `asChild` hands the chip chrome to the child, here a link, which keeps its
 * own navigation semantics. The icons are re-parented inside it.
 */
export const AsLink: Story = {
  args: { tone: "info", rightIcon: <ExternalLink />, asChild: true },
  render: (args) => (
    <Chip {...args}>
      <a href="https://example.com" target="_blank" rel="noreferrer">
        Release notes
      </a>
    </Chip>
  ),
};
