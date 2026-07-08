import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";

import { MultiActivityGroup, type MultiActivityGroupProps } from "./multi-activity-group";

/**
 * Build a realistic {@link ChatMessageToolCall}. Defaults to a completed bash
 * call; callers override `toolName` / `input` / `status` / timings per story.
 * `startedAt` / `completedAt` default to a 2s window so durations render.
 */
function makeToolCall(
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  const startedAt = 1_717_000_000_000;
  return {
    id: `tc-${Math.random().toString(36).slice(2, 8)}`,
    name: "bash",
    input: { command: "date", activity: "Checking the current time" },
    riskLevel: "low",
    startedAt,
    completedAt: startedAt + 2_000,
    ...overrides,
  };
}

/**
 * Default, no-op pass-through props so each story only has to supply the
 * `toolCalls` (and optionally `items`). The group renders as an inline header
 * that opens the activity-steps side panel on click — see the
 * `Chat/ActivityStepsPanel` stories for the timeline itself.
 */
function baseProps(
  overrides: Partial<MultiActivityGroupProps> = {},
): MultiActivityGroupProps {
  return {
    toolCalls: [],
    ...overrides,
  };
}

/** Pull the tool calls out of an ordered items list (for the `toolCalls` prop). */
function toolCallsFromItems(items: ToolCallCardItem[]): ChatMessageToolCall[] {
  return items
    .filter(
      (i): i is { kind: "toolCall"; toolCall: ChatMessageToolCall } =>
        i.kind === "toolCall",
    )
    .map((i) => i.toolCall);
}

const meta: Meta<typeof MultiActivityGroup> = {
  title: "Chat/MultiActivityGroup",
  component: MultiActivityGroup,
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof MultiActivityGroup>;

// ---------------------------------------------------------------------------
// Interleaved thinking + tool variants — the merged activity-run cases.
//
// `MultiActivityGroup` is strictly for runs with MORE THAN ONE activity. A lone
// single tool (or lone thinking step) renders as the inline `SingleActivity`
// link instead — see that component's stories for the single-step cases.
// ---------------------------------------------------------------------------

/**
 * The KEY merged case: a completed bash tool followed by a trailing thinking
 * step. The collapsed header carousels to the latest step, so it shows the
 * brain glyph + thinking text rather than the tool title.
 */
export const ToolThenThinking: Story = {
  render: () => {
    const items: ToolCallCardItem[] = [
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          input: { command: "date", activity: "Checking the current time" },
        }),
      },
      {
        kind: "thinking",
        text: "Got the date. Now let me do a second tool call.",
      },
    ];
    return (
      <MultiActivityGroup
        {...baseProps({ items, toolCalls: toolCallsFromItems(items) })}
      />
    );
  },
};

/**
 * Multi-step interleaved run mirroring the activity-summary screenshots:
 * thinking → tool → thinking → tool → thinking. The header carousels to the
 * trailing thinking step.
 */
export const InterleavedRun: Story = {
  render: () => {
    const start = 1_717_000_000_000;
    const items: ToolCallCardItem[] = [
      {
        kind: "thinking",
        text: "Tirman wants me to test a UI thing. Let me check the current state file first.",
      },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          name: "str_replace_editor",
          input: {
            command: "view",
            path: "/workspace/NOW.md",
            activity: "Reading current state file",
          },
          startedAt: start,
          completedAt: start + 1_000,
        }),
      },
      { kind: "thinking", text: "Got the current state." },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          input: {
            command: "ls /workspace | wc -l",
            activity: "Counting files in the workspace",
          },
          startedAt: start + 1_000,
          completedAt: start + 4_000,
        }),
      },
      {
        kind: "thinking",
        text: "Got the results. It's 17:33 UTC and there are 17 files in the workspace.",
      },
    ];
    return (
      <MultiActivityGroup
        {...baseProps({ items, toolCalls: toolCallsFromItems(items) })}
      />
    );
  },
};

/**
 * A trailing thinking step with a very long string (>120 chars) to demonstrate
 * the header truncation / concatenation (`HEADER_INFO_MAX_CHARS`) and the pill
 * cap (`THINKING_PILL_MAX_CHARS`).
 */
export const LongThinkingHeader: Story = {
  render: () => {
    const items: ToolCallCardItem[] = [
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          input: { command: "date", activity: "Checking the current time" },
        }),
      },
      {
        kind: "thinking",
        text: "Got the date back from the shell. Now I need to reason carefully about what the user actually asked for, cross-reference it against the workspace state I read earlier, and decide whether a second tool call is warranted before I respond.",
      },
    ];
    return (
      <MultiActivityGroup
        {...baseProps({ items, toolCalls: toolCallsFromItems(items) })}
      />
    );
  },
};

// ---------------------------------------------------------------------------
// Status / tool-kind variants — shown inside a multi-activity run, since a lone
// single (non-web) tool renders as the inline `SingleActivity` link, not this
// card.
// ---------------------------------------------------------------------------

/** A failing tool within a run — exercises the error header chrome. */
export const ErrorTool: Story = {
  render: () => {
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "Let me try that command." },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          isError: true,
          result: "bash: nonexistent-command: command not found",
          input: {
            command: "nonexistent-command --help",
            activity: "Trying an unknown command",
          },
        }),
      },
    ];
    return (
      <MultiActivityGroup
        {...baseProps({ items, toolCalls: toolCallsFromItems(items) })}
      />
    );
  },
};

/** A skill step within a run — exercises the skill glyph + label. */
export const SkillTool: Story = {
  render: () => {
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "I'll kick off the review cycle." },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          name: "skill_execute",
          input: { skill: "review-cycle", activity: "Using a skill" },
          riskLevel: undefined,
        }),
      },
    ];
    return (
      <MultiActivityGroup
        {...baseProps({ items, toolCalls: toolCallsFromItems(items) })}
      />
    );
  },
};

/**
 * A LONE purely-web `web_search` group (exactly one web tool call). The
 * dispatcher routes this through the inline, expand-in-place `SingleActivity`
 * web link — "Web Search | <rotating WebsiteCarousel>" that expands to the
 * favicon result row in place — rather than a boxed card. Grouped (2+) web
 * goes through the unified bare activity card instead (see
 * {@link GroupedWebSearch}). The favicon chips + carousel header derive from
 * the call's `activityMetadata.webSearch`.
 */
export const WebSearch: Story = {
  args: baseProps({
    toolCalls: [
      makeToolCall({
        name: "web_search",
        riskLevel: undefined,
        input: { query: "current time in Toronto" },
        activityMetadata: {
          webSearch: {
            query: "current time in Toronto",
            provider: "anthropic-native",
            resultCount: 2,
            durationMs: 1_400,
            results: [
              {
                rank: 1,
                title: "Current Local Time in Toronto, Ontario, Canada",
                url: "https://www.timeanddate.com/worldclock/canada/toronto",
                domain: "timeanddate.com",
              },
              {
                rank: 2,
                title: "Toronto Time — Time Zone Converter",
                url: "https://time.is/Toronto",
                domain: "time.is",
              },
            ],
          },
        },
      }),
    ],
  }),
};

/**
 * A GROUPED purely-web group: TWO `web_search` calls. Unlike the lone case,
 * this renders through the unified bare `MultiActivityGroup` card with the
 * favicon-timeline expanded body — one `web_search` step per call grouped under
 * a single phase header.
 */
export const GroupedWebSearch: Story = {
  args: baseProps({
    toolCalls: [
      makeToolCall({
        name: "web_search",
        riskLevel: undefined,
        input: { query: "current time in Toronto" },
        activityMetadata: {
          webSearch: {
            query: "current time in Toronto",
            provider: "anthropic-native",
            resultCount: 1,
            durationMs: 1_400,
            results: [
              {
                rank: 1,
                title: "Current Local Time in Toronto, Ontario, Canada",
                url: "https://www.timeanddate.com/worldclock/canada/toronto",
                domain: "timeanddate.com",
              },
            ],
          },
        },
      }),
      makeToolCall({
        name: "web_search",
        riskLevel: undefined,
        input: { query: "weather in Toronto" },
        activityMetadata: {
          webSearch: {
            query: "weather in Toronto",
            provider: "anthropic-native",
            resultCount: 1,
            durationMs: 900,
            results: [
              {
                rank: 1,
                title: "Toronto, ON — 7 Day Forecast",
                url: "https://weather.gc.ca/city/pages/on-143_metric_e.html",
                domain: "weather.gc.ca",
              },
            ],
          },
        },
      }),
    ],
  }),
};

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * A run with a still-running tool: the header renders no status icon — the
 * carousel title carries the loading signal via the avatar-tinted shimmer
 * sweep (`StreamingShimmerText`).
 */
export const Streaming: Story = {
  render: () => {
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "Checking the time, then the workspace." },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          completedAt: undefined,
          input: { command: "date", activity: "Checking the current time" },
        }),
      },
    ];
    return (
      <MultiActivityGroup
        {...baseProps({ items, toolCalls: toolCallsFromItems(items) })}
      />
    );
  },
};
