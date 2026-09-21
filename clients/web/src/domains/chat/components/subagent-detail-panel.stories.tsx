import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  useSubagentStore,
  type SubagentEntry,
} from "@/domains/chat/subagent-store";
import { emptyHistory } from "@/domains/chat/transcript/rolling-snapshot";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { SubagentDetailPanel } from "./subagent-detail-panel";

const meta: Meta<typeof SubagentDetailPanel> = {
  title: "Chat/SubagentDetailPanel",
  component: SubagentDetailPanel,
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
  spawnedAt: now,
  history: null,
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

/**
 * An objective long enough to fold. It folds the way every long value in a
 * detail panel does, behind the shared Show more.
 */
export const LongObjective: Story = {
  args: {
    entry: {
      ...runningEntry,
      objective: [
        "Determine which province and country Toronto is located in, and summarise its geographic context.",
        "Cover the Greater Toronto Area and how it relates to the city proper, the shoreline of Lake Ontario, and the major river valleys that cross the city.",
        "Note the neighbouring municipalities to the east, west and north, and the regional governments they belong to.",
        "Finish with a short paragraph on how the city's position on the lake shaped its early growth as a port and rail hub, with one or two dates where they help.",
        "Keep it under three hundred words, cite the sources you used, and flag anything you could not confirm from more than one source.",
      ].join("\n\n"),
    },
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

const commandCallEntry: SubagentEntry = {
  ...runningEntry,
  subagentId: "sub-disk-usage",
  label: "Disk agent",
  objective: "Find what is using the most space in the project folder.",
  status: "completed",
  events: [
    {
      id: "te-du-call",
      type: "tool_call",
      content: "du -sh * | sort -h",
      toolName: "bash",
      toolUseId: "tool-du",
      input: {
        command: "du -sh * | sort -h",
        activity: "Measuring folder sizes",
      },
      timestamp: now,
    },
    {
      id: "te-du-result",
      type: "tool_result",
      content: "4.0K\tREADME.md\n212M\tnode_modules",
      result: "4.0K\tREADME.md\n212M\tnode_modules",
      toolName: "bash",
      toolUseId: "tool-du",
      timestamp: now + 1400,
    },
  ],
  history: {
    ...emptyHistory(),
    messages: [
      {
        id: "msg-du",
        role: "assistant",
        toolCalls: [
          {
            id: "tool-du",
            name: "bash",
            input: {
              command: "du -sh * | sort -h",
              activity: "Measuring folder sizes",
            },
            result: "4.0K\tREADME.md\n212M\tnode_modules",
            riskLevel: "medium",
            startedAt: now,
            completedAt: now + 1400,
          },
        ],
      },
    ],
  },
};

/**
 * A finished subagent whose tool call opens from its timeline. The nested
 * detail reads the call from the subagent's history in the store, the same
 * `ChatMessageToolCall` a main-chat call carries, so it shows the risk level.
 * Click the command pill to open it.
 */
export const ToolCallDetail: Story = {
  beforeEach: () => {
    useSubagentStore.setState((state) => ({
      byId: { ...state.byId, [commandCallEntry.subagentId]: commandCallEntry },
    }));
  },
  args: {
    entry: commandCallEntry,
    onClose: () => {},
  },
};
