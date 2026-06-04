import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { useViewerStore } from "@/stores/viewer-store";

import { InlineToolLink } from "./inline-tool-link";

/**
 * Build a realistic {@link ChatMessageToolCall}. Defaults to a completed bash
 * call with a 2s window so durations resolve. Mirrors the helper in
 * `activity-run-card.stories.tsx`.
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

const meta: Meta<typeof InlineToolLink> = {
  title: "Chat/InlineToolLink",
  component: InlineToolLink,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof InlineToolLink>;

export const Bash: Story = {
  args: {
    toolCall: makeToolCall({
      id: "tc-bash",
      input: { command: "date", activity: "Checking the current time" },
      riskLevel: "low",
    }),
  },
};

export const Skill: Story = {
  args: {
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
export const Active: Story = {
  args: {
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

export const Error: Story = {
  args: {
    toolCall: makeToolCall({
      id: "tc-error",
      isError: true,
      input: { command: "exit 1", activity: "Running a failing command" },
      riskLevel: "low",
    }),
  },
};
