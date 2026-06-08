import type { Meta, StoryObj } from "@storybook/react-vite";
import { Brain } from "lucide-react";

import { InlineActivityLink } from "./inline-activity-link";

const meta: Meta<typeof InlineActivityLink> = {
  title: "Chat/InlineActivityLink",
  component: InlineActivityLink,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof InlineActivityLink>;

const brainIcon = <Brain className="size-4 shrink-0" aria-hidden />;

export const Default: Story = {
  args: {
    icon: brainIcon,
    label: "Thought process",
    ariaLabel: "View thinking",
    onClick: () => {},
  },
};

export const WithRiskBadge: Story = {
  args: {
    icon: brainIcon,
    label: "Working (bash)",
    riskLevel: "low",
    ariaLabel: "View details",
    onClick: () => {},
  },
};

export const Active: Story = {
  args: {
    icon: brainIcon,
    label: "Thought process",
    active: true,
    ariaLabel: "View thinking",
    onClick: () => {},
  },
};

export const Error: Story = {
  args: {
    icon: brainIcon,
    label: "Working (bash)",
    tone: "error",
    ariaLabel: "View details",
    onClick: () => {},
  },
};

export const NoChevron: Story = {
  args: {
    icon: brainIcon,
    label: "Thought process",
    showChevron: false,
    ariaLabel: "View thinking",
    onClick: () => {},
  },
};
