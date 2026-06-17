import type { Meta, StoryObj } from "@storybook/react-vite";

import { RiskBadge } from "./risk-badge";

const meta: Meta<typeof RiskBadge> = {
  title: "Chat/RiskBadge",
  component: RiskBadge,
  parameters: {
    layout: "padded",
  },
  argTypes: {
    level: {
      control: "select",
      options: ["low", "medium", "high", "workspace"],
    },
  },
};

export default meta;
type Story = StoryObj<typeof RiskBadge>;

export const Low: Story = {
  args: { level: "low" },
};

export const Medium: Story = {
  args: { level: "medium" },
};

export const High: Story = {
  args: { level: "high" },
};

export const Workspace: Story = {
  args: { level: "workspace" },
};

export const AllLevels: Story = {
  parameters: {
    controls: { disable: true },
  },
  render: () => (
    <div className="flex flex-row items-center gap-2">
      <RiskBadge level="low" />
      <RiskBadge level="medium" />
      <RiskBadge level="high" />
      <RiskBadge level="workspace" />
    </div>
  ),
};
