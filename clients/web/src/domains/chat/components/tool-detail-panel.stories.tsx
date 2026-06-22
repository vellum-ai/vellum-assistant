import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ToolDetailPayload } from "@/stores/viewer-store";

import { ToolDetailPanel } from "./tool-detail-panel";

const meta: Meta<typeof ToolDetailPanel> = {
  title: "Chat/ToolDetailPanel",
  component: ToolDetailPanel,
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
type Story = StoryObj<typeof ToolDetailPanel>;

const subagentDetail: ToolDetailPayload = {
  toolCallId: "tc-subagent-1",
  toolName: "subagent_spawn",
  title: "Spawning subagent",
  activity: "Spawning subagent to research Toronto's location in Canada",
  input: {
    label: "toronto-location",
    objective:
      "Determine which province and country Toronto is located in, and summarise its geographic context.",
    role: "researcher",
  },
  result: JSON.stringify(
    {
      summary:
        "Toronto is the capital city of the province of Ontario, located in Canada on the northwestern shore of Lake Ontario.",
      sources: ["wikipedia.org", "britannica.com"],
    },
    null,
    2,
  ),
  status: "completed",
  riskLevel: "low",
};

const bashDetail: ToolDetailPayload = {
  toolCallId: "tc-bash-1",
  toolName: "bash",
  title: "Working",
  activity: "",
  input: { command: "ls -la" },
  result:
    "total 24\ndrwxr-xr-x  5 user  staff   160 May 27 10:00 .\ndrwxr-xr-x 12 user  staff   384 May 27 09:58 ..\n-rw-r--r--  1 user  staff  1024 May 27 10:00 README.md",
  status: "completed",
  riskLevel: "medium",
};

const thinkingDetail: ToolDetailPayload = {
  toolCallId: "",
  toolName: "",
  title: "Thinking",
  activity: "",
  input: {},
  status: "completed",
  kind: "thinking",
  thinkingText: [
    "Tirman wants me to test a UI thing. Let me reason through it.",
    "",
    "First, I'll check the current state file to understand where things stand. Then I can decide whether a second tool call is warranted before responding.",
    "",
    "- The workspace currently has **17 files**.",
    "- The clock reads `17:33 UTC`.",
    "",
    "Given that, the plan is to run one more `bash` command and then summarise.",
  ].join("\n"),
};

export const Thinking: Story = {
  args: {
    detail: thinkingDetail,
    onClose: () => {},
  },
};

export const SubagentSpawn: Story = {
  args: {
    detail: subagentDetail,
    onClose: () => {},
  },
};

export const Bash: Story = {
  args: {
    detail: bashDetail,
    onClose: () => {},
  },
};
