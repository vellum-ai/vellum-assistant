import type { Meta, StoryObj } from "@storybook/react-vite";

import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { BackgroundTaskDetailPanel } from "./background-task-detail-panel";

const meta: Meta<typeof BackgroundTaskDetailPanel> = {
  title: "Chat/BackgroundTaskDetailPanel",
  component: BackgroundTaskDetailPanel,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <Story />
      </DetailPanelStoryFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BackgroundTaskDetailPanel>;

const runningEntry: BackgroundTaskEntry = {
  id: "bg-abc12345",
  toolName: "bash",
  conversationId: "conv-1",
  command: "npm run build -- --watch",
  startedAt: Date.now() - 4_000,
  status: "running",
};

const completedEntry: BackgroundTaskEntry = {
  id: "bg-def67890",
  toolName: "bash",
  conversationId: "conv-1",
  command: "npm run build",
  startedAt: Date.now() - 4_200,
  status: "completed",
  exitCode: 0,
  output: "Build succeeded in 4.2s",
  completedAt: Date.now(),
};

const failedEntry: BackgroundTaskEntry = {
  id: "bg-fail1234",
  toolName: "bash",
  conversationId: "conv-1",
  command: "npm test",
  startedAt: Date.now() - 2_000,
  status: "failed",
  exitCode: 1,
  output: "FAIL src/app.test.ts\n1 test failed",
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

export const Failed: Story = {
  args: {
    entry: failedEntry,
    onClose: () => {},
  },
};
