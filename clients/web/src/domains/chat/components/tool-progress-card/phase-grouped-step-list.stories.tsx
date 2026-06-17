import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";

import { PhaseGroupedStepList } from "./phase-grouped-step-list";

/**
 * Construct a `tool` step descriptor with sensible defaults. Stories override
 * the fields that matter for the case under test (title drives phase grouping;
 * status drives the section header icon).
 */
function toolStep(overrides: Partial<
  Extract<ToolCallCardStep, { kind: "tool" }>
> = {}): ToolCallCardStep {
  return {
    kind: "tool",
    durationLabel: "2s",
    title: "Working",
    info: "date",
    activity: "Checking the current time",
    iconName: "code",
    toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
    status: "completed",
    ...overrides,
  };
}

function thinkingStep(text: string): ToolCallCardStep {
  return { kind: "thinking", durationLabel: "", text };
}

const meta: Meta<typeof PhaseGroupedStepList> = {
  title: "Chat/PhaseGroupedStepList",
  component: PhaseGroupedStepList,
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="w-[400px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof PhaseGroupedStepList>;

/**
 * A mixed run: Thinking → Working → Thinking. Each contiguous same-phase
 * run collapses into its own phase section with header + indented pills.
 */
export const MixedRun: Story = {
  args: {
    steps: [
      thinkingStep("Let me check the current time before I answer."),
      toolStep({
        info: "date",
        durationLabel: "<1s",
      }),
      thinkingStep("Got it — 17:33 UTC. Now I can respond."),
    ],
  },
};

/** A tool-only run with two bash steps grouped under one "Working" header. */
export const ToolOnly: Story = {
  args: {
    steps: [
      toolStep({ info: "git status", durationLabel: "<1s" }),
      toolStep({ info: "ls /workspace | wc -l", durationLabel: "3s" }),
    ],
  },
};

/** A run that ends in a failed tool step — the phase header renders the error icon. */
export const ErrorStep: Story = {
  args: {
    steps: [
      toolStep({ info: "git status", durationLabel: "<1s" }),
      toolStep({
        info: "nonexistent-command --help",
        durationLabel: "<1s",
        status: "error",
      }),
    ],
  },
};

/** A thinking-only list — a single "Thinking" phase section. */
export const ThinkingOnly: Story = {
  args: {
    steps: [
      thinkingStep("Tirman wants me to test a UI thing."),
      thinkingStep("Let me reason about the expected behaviour first."),
    ],
  },
};

/**
 * The vertical timeline variant (`timeline`): each phase's status icon becomes
 * a circular node in a left column joined by a continuous connector line, with
 * the header + steps flowing in a right content column. Used by the
 * MultiActivityGroup; web-search / subagent cards keep the flat layout above.
 */
export const Timeline: Story = {
  args: {
    timeline: true,
    steps: [
      thinkingStep("Let me check the current time before I answer."),
      toolStep({ info: "date", durationLabel: "<1s" }),
      toolStep({ info: "git status", durationLabel: "2s" }),
      thinkingStep("Got it — now I can respond."),
      toolStep({
        info: "nonexistent-command --help",
        durationLabel: "<1s",
        status: "error",
      }),
    ],
  },
};
