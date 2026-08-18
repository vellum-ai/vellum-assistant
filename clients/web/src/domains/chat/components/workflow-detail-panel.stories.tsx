import type { Meta, StoryObj } from "@storybook/react-vite";

import type {
  WorkflowEntry,
  WorkflowLeaf,
} from "@/domains/chat/workflow-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { WorkflowDetailPanel } from "./workflow-detail-panel";

const meta: Meta<typeof WorkflowDetailPanel> = {
  title: "Chat/WorkflowDetailPanel",
  component: WorkflowDetailPanel,
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
type Story = StoryObj<typeof WorkflowDetailPanel>;

function leafMap(leaves: WorkflowLeaf[]): Map<number, WorkflowLeaf> {
  return new Map(leaves.map((leaf) => [leaf.seq, leaf]));
}

const runningEntry: WorkflowEntry = {
  runId: "run-research",
  label: "Research workflow",
  status: "running",
  agentsSpawned: 3,
  inputTokens: 4200,
  outputTokens: 1180,
  startedAt: Date.now(),
  leaves: leafMap([
    {
      seq: 0,
      label: "Searching the web",
      promptSummary: "Search the web for X",
      status: "running",
    },
    {
      seq: 1,
      label: "Summarising sources",
      status: "completed",
      resultSummary: "Found three sources",
    },
    { seq: 2, label: "Drafting outline", status: "failed" },
  ]),
};

const emptyEntry: WorkflowEntry = {
  runId: "run-empty",
  label: "New workflow",
  status: "running",
  agentsSpawned: 0,
  inputTokens: 0,
  outputTokens: 0,
  startedAt: Date.now(),
  leaves: new Map(),
};

export const Running: Story = {
  args: {
    entry: runningEntry,
    onClose: () => {},
    onStop: () => {},
  },
};

export const Empty: Story = {
  args: {
    entry: emptyEntry,
    onClose: () => {},
  },
};
