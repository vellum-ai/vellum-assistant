import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useViewerStore } from "@/stores/viewer-store";

import { SingleActivity } from "./single-activity";

/**
 * Build a realistic {@link ChatMessageToolCall}. Defaults to a completed bash
 * call with a 2s window so durations resolve.
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

const REASONING =
  "The user is asking for a summary of the recent activity. Let me think " +
  "through what's changed: there are a handful of uncommitted edits in the " +
  "web app, and the most relevant ones touch the chat transcript. I'll " +
  "highlight those before drilling into specifics.";

const meta: Meta<typeof SingleActivity> = {
  title: "Chat/SingleActivity",
  component: SingleActivity,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof SingleActivity>;

// ---------------------------------------------------------------------------
// Thinking variant
// ---------------------------------------------------------------------------

export const Thinking: Story = {
  args: {
    variant: "thinking",
    content: REASONING,
  },
};

/**
 * Streaming — the link owns the loading state: the brain glyph is swapped for
 * the shared three-dot indicator and the label reads "Thinking". It stays
 * clickable so the reasoning-so-far opens in the drawer mid-stream.
 */
export const ThinkingStreaming: Story = {
  args: {
    variant: "thinking",
    content: REASONING,
    isStreaming: true,
  },
};

/**
 * Streaming, before any reasoning text has landed. The link still renders (so
 * it can be the single thinking affordance from the very start of the turn) —
 * dots + "Thinking", with an empty drawer until content arrives.
 */
export const ThinkingStreamingEmpty: Story = {
  args: {
    variant: "thinking",
    content: "",
    isStreaming: true,
  },
};

/**
 * Active state — the link whose reasoning is currently open in the side drawer
 * renders its label in `--content-default`. The decorator primes the viewer
 * store with a matching thinking payload on mount.
 */
export const ThinkingActive: Story = {
  args: {
    variant: "thinking",
    content: REASONING,
  },
  decorators: [
    (StoryFn) => {
      useViewerStore.getState().openToolDetail({
        kind: "thinking",
        toolCallId: "",
        toolName: "",
        title: "Thought process",
        activity: "",
        input: {},
        status: "completed",
        thinkingText: REASONING,
      });
      return <StoryFn />;
    },
  ],
};

// ---------------------------------------------------------------------------
// Tool variant
// ---------------------------------------------------------------------------

export const ToolBash: Story = {
  args: {
    variant: "tool",
    toolCall: makeToolCall({
      id: "tc-bash",
      input: { command: "date", activity: "Checking the current time" },
      riskLevel: "low",
    }),
  },
};

export const ToolSkill: Story = {
  args: {
    variant: "tool",
    toolCall: makeToolCall({
      id: "tc-skill",
      name: "skill_execute",
      input: { skill: "deep-research", activity: "Running deep research" },
      riskLevel: undefined,
    }),
  },
};

/**
 * Active state — the chip whose detail drawer is currently open renders the
 * filled highlight. The decorator primes the viewer store with a matching tool
 * payload on mount.
 */
export const ToolActive: Story = {
  args: {
    variant: "tool",
    toolCall: makeToolCall({ id: "tc-active", riskLevel: "low" }),
  },
  decorators: [
    (StoryFn) => {
      useViewerStore.getState().openToolDetail({
        toolCallId: "tc-active",
        toolName: "bash",
        title: "Working (bash)",
        activity: "Checking the current time",
        input: {},
        status: "completed",
      });
      return <StoryFn />;
    },
  ],
};

export const ToolError: Story = {
  args: {
    variant: "tool",
    toolCall: makeToolCall({
      id: "tc-error",
      isError: true,
      input: { command: "exit 1", activity: "Running a failing command" },
      riskLevel: "low",
    }),
  },
};
