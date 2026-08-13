import type { Meta, StoryObj } from "@storybook/react-vite";

import type { AcpRunEntry } from "@/domains/chat/acp-run-store";

import { AcpRunDetailPanel } from "./acp-run-detail-panel";

const meta: Meta<typeof AcpRunDetailPanel> = {
  title: "Chat/AcpRunDetailPanel",
  component: AcpRunDetailPanel,
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
type Story = StoryObj<typeof AcpRunDetailPanel>;

const runningEntry: AcpRunEntry = {
  acpSessionId: "acp-ibm",
  agent: "claude",
  parentConversationId: "conv-1",
  task: "Review IBM's Q2 2026 results and five-year prospects, then give a focused strategic recommendation.",
  status: "running",
  startedAt: Date.now() - 61_500,
  usedTokens: 61_500,
  contextSize: 200_000,
  inputTokens: 61_500,
  outputTokens: 1_700,
  events: [],
};

const completedEntry: AcpRunEntry = {
  ...runningEntry,
  acpSessionId: "acp-ibm-done",
  status: "completed",
  completedAt: Date.now(),
};

export const Running: Story = {
  args: {
    entry: runningEntry,
    onClose: () => {},
  },
};

export const Completed: Story = {
  args: {
    entry: completedEntry,
    onClose: () => {},
  },
};
