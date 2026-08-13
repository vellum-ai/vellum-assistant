import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ToolDetailPayload } from "@/stores/viewer-store";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";

import { ToolDetailPanel } from "./tool-detail-panel";

const meta: Meta<typeof ToolDetailPanel> = {
  title: "Chat/ToolDetailPanel",
  component: ToolDetailPanel,
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

/**
 * A `skill_load` body shaped like the daemon's real output: instruction
 * markdown followed by the machine-facing "## Available Tools" manifest that
 * `formatToolSchemas` emits.
 */
const skillLoadResult = [
  "Skill: App Builder",
  "ID: app-builder",
  "Description: Build persistent apps in the user's Library.",
  "Path: /skills/app-builder/SKILL.md",
  "",
  "# App Builder",
  "",
  "Build **persistent apps** in the user's Library — dashboards, trackers,",
  "calculators, and games that survive across conversations.",
  "",
  "## Workflow",
  "",
  "1. Call `app_create` with a display name.",
  "2. Write the app source into the returned folder.",
  "3. Call `app_refresh` to rebuild and preview.",
  "",
  "## Available Tools",
  "",
  "Use `skill_execute` to call these tools.",
  "",
  "### app_create",
  "Create a new app in the user's Library and return its folder path.",
  "Parameters:",
  "- name (string, required): Display name shown in the Library.",
  "- template (string, optional): Starter template id.",
  "",
  "### app_refresh",
  "Rebuild an existing app and refresh any open preview.",
  "Parameters:",
  "- app_id (string, required): Id returned by app_create.",
  "",
  // Machine-only trailer the daemon appends. Must not leak into the last
  // tool's description or the rendered instructions.
  "Included Skills (immediate): none",
  "",
  '<loaded_skill id="app-builder" version="abc123" />',
].join("\n");

const skillLoadDetail: ToolDetailPayload = {
  toolCallId: "tc-skill-load-1",
  toolName: "skill_load",
  title: "Using a skill",
  activity: "Loading the app-builder skill",
  input: { skill: "app-builder" },
  result: skillLoadResult,
  status: "completed",
  riskLevel: "low",
};

const skillLoadErrorDetail: ToolDetailPayload = {
  toolCallId: "tc-skill-load-2",
  toolName: "skill_load",
  title: "Using a skill",
  activity: "Loading the meet-join skill",
  input: { skill: "meet-join" },
  result:
    "Error: skill 'meet-join' is currently unavailable. This skill is feature-gated and not enabled for this workspace.",
  status: "error",
};

const skillExecuteDetail: ToolDetailPayload = {
  toolCallId: "tc-skill-exec-1",
  toolName: "skill_execute",
  title: "Using a skill",
  activity: "Creating your budget tracker app",
  input: {
    tool: "app_create",
    input: {
      name: "Budget tracker",
      template: "dashboard",
      public: false,
      config: { currency: "USD", categories: ["rent", "food", "transit"] },
    },
    activity: "Creating your budget tracker app",
  },
  result: "Created app 'Budget tracker' at ~/Library/apps/budget-tracker",
  status: "completed",
  riskLevel: "low",
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

/**
 * `skill_load` with a purpose-built body: the skill's identity and a View
 * action up top, the manifest as a scannable tool list, and the instruction
 * markdown rendered (not dumped as a `<pre>`) under Output.
 */
export const SkillLoad: Story = {
  args: {
    detail: skillLoadDetail,
    onClose: () => {},
  },
};

/**
 * A realistically long skill body: Output clamps it behind "Show more", and
 * the Clean/Raw switch flips between the rendered markdown and the daemon's
 * verbatim result (header lines and tool manifest included).
 */
export const SkillLoadLongBody: Story = {
  args: {
    detail: {
      ...skillLoadDetail,
      result: skillLoadResult.replace(
        "## Workflow",
        [
          "## When to use this",
          "",
          "Reach for the app builder when the user asks for something that",
          "should outlive the conversation — a tracker they'll come back to, a",
          "dashboard over their own data, a small tool they'd otherwise rebuild",
          "by hand each time. A one-off calculation or a chart they only need",
          "once is not an app; answer it inline instead.",
          "",
          "## Workflow",
        ].join("\n"),
      ),
    },
    onClose: () => {},
  },
};

/** A failed `skill_load` — the error reads as prose, not as raw tool output. */
export const SkillLoadError: Story = {
  args: {
    detail: skillLoadErrorDetail,
    onClose: () => {},
  },
};

/** `skill_load` still in flight, before the instruction body lands. */
export const SkillLoadRunning: Story = {
  args: {
    detail: { ...skillLoadDetail, result: undefined, status: "running" },
    onClose: () => {},
  },
};

/**
 * `skill_execute` with its envelope unwrapped: the inner tool leads, and its
 * parameters render as a labelled list instead of nested JSON.
 */
export const SkillExecute: Story = {
  args: {
    detail: skillExecuteDetail,
    onClose: () => {},
  },
};
