import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SubagentEntry } from "@/domains/chat/subagent-store";

import { SubagentDetailPanel } from "./subagent-detail-panel";

const meta: Meta<typeof SubagentDetailPanel> = {
  title: "Chat/SubagentDetailPanel",
  component: SubagentDetailPanel,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-[440px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SubagentDetailPanel>;

const now = Date.now();

const runningEntry: SubagentEntry = {
  subagentId: "sub-toronto",
  label: "Research agent",
  objective:
    "Determine which province and country Toronto is located in, and summarise its geographic context.",
  status: "running",
  isFork: false,
  inputTokens: 1200,
  outputTokens: 340,
  totalCost: 0.68,
  spawnedAt: now,
  events: [
    {
      id: "te-call",
      type: "tool_call",
      content: "toronto location",
      toolName: "web_search",
      toolUseId: "tool-1",
      input: { query: "Toronto province country" },
      timestamp: now,
    },
  ],
};

const completedEntry: SubagentEntry = {
  ...runningEntry,
  subagentId: "sub-toronto-done",
  status: "completed",
  inputTokens: 2400,
  outputTokens: 680,
  totalCost: 1.12,
  events: [
    ...runningEntry.events,
    {
      id: "te-result",
      type: "tool_result",
      content: "Toronto is in Ontario, Canada.",
      result: "Toronto is in Ontario, Canada.",
      toolName: "web_search",
      toolUseId: "tool-1",
      timestamp: now + 1000,
    },
  ],
};

export const Running: Story = {
  args: {
    entry: runningEntry,
    onClose: () => {},
    onStop: () => {},
  },
};

export const Completed: Story = {
  args: {
    entry: completedEntry,
    onClose: () => {},
  },
};

export const Empty: Story = {
  args: {
    entry: {
      ...runningEntry,
      subagentId: "sub-empty",
      status: "completed",
      events: [],
    },
    onClose: () => {},
  },
};
