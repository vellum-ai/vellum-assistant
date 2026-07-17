import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";

import { ActivityStepsPanel } from "./activity-steps-panel";

/**
 * The activity-steps side panel (Figma `6405-121430`): one activity group's
 * full phase-grouped timeline, with in-panel drill-in to step details and an
 * "All steps" back button. Opened by clicking a `MultiActivityGroup` header
 * in the transcript.
 */

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & { id: string },
): ChatMessageToolCall {
  const startedAt = 1_717_000_000_000;
  return {
    name: "bash",
    input: { command: "date", activity: "Checking the current time" },
    riskLevel: "low",
    startedAt,
    completedAt: startedAt + 2_000,
    result: "ok",
    ...overrides,
  };
}

const START = 1_717_000_000_000;

const WEB_SEARCH = makeToolCall({
  id: "tc-web",
  name: "web_search",
  riskLevel: undefined,
  input: { query: "most popular social media sites" },
  startedAt: START + 2_000,
  completedAt: START + 6_000,
  activityMetadata: {
    webSearch: {
      query: "most popular social media sites",
      provider: "anthropic-native",
      resultCount: 3,
      durationMs: 4_000,
      results: [
        {
          rank: 1,
          title: "This is a webpage title",
          url: "https://example.com/a",
          domain: "example.com",
        },
        {
          rank: 2,
          title: "This is another webpage title",
          url: "https://example.org/b",
          domain: "example.org",
        },
        {
          rank: 3,
          title: "New webpage title",
          url: "https://example.net/c",
          domain: "example.net",
        },
      ],
    },
  },
});

const SKILL = makeToolCall({
  id: "tc-skill",
  name: "skill_execute",
  riskLevel: undefined,
  input: { skill: "critical-thinking", activity: "Using a skill" },
  startedAt: START + 6_000,
  completedAt: START + 54_000,
});

const RISKY_BASH = makeToolCall({
  id: "tc-bash",
  name: "bash",
  riskLevel: "high",
  input: {
    command: "curl -s https://example.com/api",
    activity: "Fetching the example API",
  },
  startedAt: START + 54_000,
  completedAt: START + 60_000,
  result: '{ "status": "ok" }',
});

const ITEMS: ToolCallCardItem[] = [
  {
    kind: "thinking",
    text: "I'll look at the most popular websites first.",
    startedAt: START,
    completedAt: START + 2_000,
  },
  { kind: "toolCall", toolCall: WEB_SEARCH },
  {
    kind: "thinking",
    text: "I'm going to look at some more pages because I'm unsure of this.",
    startedAt: START + 6_000,
    completedAt: START + 7_000,
  },
  { kind: "toolCall", toolCall: SKILL },
  { kind: "toolCall", toolCall: RISKY_BASH },
  {
    kind: "thinking",
    text: "Summarising all I learned into an easily digestible format.",
    startedAt: START + 60_000,
    completedAt: START + 66_000,
  },
];

const TOOL_CALLS = [WEB_SEARCH, SKILL, RISKY_BASH];

const meta: Meta<typeof ActivityStepsPanel> = {
  title: "Chat/ActivityStepsPanel",
  component: ActivityStepsPanel,
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="h-[720px] w-[560px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ActivityStepsPanel>;

/**
 * A completed interleaved run: thinking → web search → thinking → skill →
 * bash → thinking. Click any thinking or tool pill to drill into its detail;
 * the "All steps" back button returns to the timeline.
 */
export const CompletedRun: Story = {
  args: {
    payload: { items: ITEMS, toolCalls: TOOL_CALLS },
    onClose: () => {},
  },
};

/**
 * A still-running run — the trailing bash call has no terminal fields, so its
 * phase node renders the running indicator and the header ticks "Working…".
 */
export const StreamingRun: Story = {
  args: {
    payload: {
      items: [
        ...ITEMS.slice(0, 4),
        {
          kind: "toolCall",
          toolCall: makeToolCall({
            id: "tc-running",
            input: {
              command: "sleep 60",
              activity: "Running a long command",
            },
            completedAt: undefined,
            result: undefined,
          }),
        },
      ],
      toolCalls: [
        WEB_SEARCH,
        SKILL,
        makeToolCall({
          id: "tc-running",
          input: { command: "sleep 60", activity: "Running a long command" },
          completedAt: undefined,
          result: undefined,
        }),
      ],
    },
    onClose: () => {},
  },
};
