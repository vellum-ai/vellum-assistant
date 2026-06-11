import type { Meta, StoryObj } from "@storybook/react-vite";

import { ToolStepPill } from "./tool-step-pill";

const meta: Meta<typeof ToolStepPill> = {
  title: "Chat/ToolStepPill",
  component: ToolStepPill,
  parameters: {
    layout: "padded",
  },
  argTypes: {
    iconName: {
      control: "select",
      options: [
        "code",
        "file",
        "pen",
        "monitor",
        "plug",
        "sparkle",
        "user-plus",
        "bolt",
        "brain",
      ],
    },
    label: { control: "text" },
    riskLevel: {
      control: "select",
      options: [undefined, "low", "medium", "high", "workspace"],
    },
    tone: {
      control: "inline-radio",
      options: ["default", "error"],
    },
    active: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof ToolStepPill>;

export const Default: Story = {
  args: {
    iconName: "sparkle",
    label: "review-cycle",
  },
};

export const WithRiskLow: Story = {
  args: {
    iconName: "code",
    label: "bun test",
    riskLevel: "low",
  },
};

export const WithRiskHigh: Story = {
  args: {
    iconName: "code",
    label: "rm -rf build",
    riskLevel: "high",
  },
};

export const LongActivity: Story = {
  args: {
    iconName: "pen",
    label:
      "Editing the phase-grouped step list to surface a button-based pill with a trailing risk badge",
  },
  render: (args) => (
    <div className="w-[320px]">
      <ToolStepPill {...args} />
    </div>
  ),
};

export const Clickable: Story = {
  args: {
    iconName: "plug",
    label: "linear.createIssue",
    riskLevel: "medium",
    onClick: () => {},
  },
};

export const ErrorTone: Story = {
  args: {
    iconName: "bolt",
    label: "Command failed with exit code 1",
    tone: "error",
  },
};

export const Active: Story = {
  args: {
    iconName: "sparkle",
    label: "review-cycle",
    riskLevel: "low",
    active: true,
    onClick: () => {},
  },
};

/**
 * Thinking pill — the new brain-branded, clickable reasoning step. Opens the
 * full reasoning in the shared tool-detail drawer when clicked.
 */
export const Thinking: Story = {
  args: {
    iconName: "brain",
    label: "Got the date. Now let me do a second tool call.",
    ariaLabel: "View thinking",
    onClick: () => {},
  },
};

/** Thinking pill in its selected state (its detail drawer is open). */
export const ThinkingActive: Story = {
  args: {
    iconName: "brain",
    label: "Got the date. Now let me do a second tool call.",
    ariaLabel: "View thinking",
    active: true,
    onClick: () => {},
  },
};

/**
 * Web variant — the same pill chrome with the site favicon as the glyph,
 * rendered as an anchor that opens the source in a new tab. Used for
 * web-search result sources. (Storybook shows the monogram fallback since the
 * sandbox can't reach external favicons.)
 */
export const Web: Story = {
  args: {
    variant: "web",
    label: "Toronto - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Toronto",
    domain: "en.wikipedia.org",
  },
};

/**
 * Several web pills laid out the way `WebSearchStepRow` renders them — a
 * `flex flex-wrap` row. The 240px per-pill cap (with truncation) lets 2–3
 * pills sit on each row instead of one-per-row even with long page titles.
 */
export const WebResults: Story = {
  parameters: {
    controls: { disable: true },
  },
  render: () => (
    <div className="flex max-w-[600px] flex-wrap gap-1">
      <ToolStepPill
        variant="web"
        label="Toronto - Wikipedia, the free encyclopedia"
        url="https://en.wikipedia.org/wiki/Toronto"
        domain="en.wikipedia.org"
      />
      <ToolStepPill
        variant="web"
        label="Toronto travel guide: the best things to do in the city"
        url="https://www.timeout.com/toronto"
        domain="timeout.com"
      />
      <ToolStepPill
        variant="web"
        label="Visit Toronto — official tourism site for the city of Toronto"
        url="https://www.destinationtoronto.com"
        domain="destinationtoronto.com"
      />
      <ToolStepPill
        variant="web"
        label="Weather in Toronto — 7 day forecast and conditions"
        url="https://weather.gc.ca/city/pages/on-143_metric_e.html"
        domain="weather.gc.ca"
      />
    </div>
  ),
};

export const AllVariants: Story = {
  parameters: {
    controls: { disable: true },
  },
  render: () => (
    <div className="flex flex-col items-start gap-2">
      <ToolStepPill iconName="sparkle" label="review-cycle" />
      <ToolStepPill iconName="code" label="bun test" riskLevel="low" />
      <ToolStepPill iconName="code" label="rm -rf build" riskLevel="high" />
      <ToolStepPill
        iconName="plug"
        label="linear.createIssue"
        riskLevel="medium"
        onClick={() => {}}
      />
      <ToolStepPill
        iconName="bolt"
        label="Command failed with exit code 1"
        tone="error"
      />
      <ToolStepPill
        iconName="sparkle"
        label="review-cycle (active)"
        riskLevel="low"
        active
        onClick={() => {}}
      />
    </div>
  ),
};
