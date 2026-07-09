import type { Meta, StoryObj } from "@storybook/react-vite";

import type { WebSearchResultItem } from "@/assistant/web-activity-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardStep } from "@/domains/chat/utils/tool-call-card-utils";
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
 * Streaming — the link owns the loading state: the label (the live reasoning
 * preview) renders through the avatar-tinted `StreamingShimmerText` sweep. It
 * stays clickable so the reasoning-so-far opens in the drawer mid-stream.
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
 * a shimmering "Thinking", with an empty drawer until content arrives.
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
        title: "Working",
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

// ---------------------------------------------------------------------------
// Web variant
// ---------------------------------------------------------------------------

const WEB_RESULTS: WebSearchResultItem[] = [
  {
    rank: 1,
    title: "Toronto - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Toronto",
    domain: "en.wikipedia.org",
  },
  {
    rank: 2,
    title: "Visit Toronto — Official Tourism",
    url: "https://www.destinationtoronto.com",
    domain: "destinationtoronto.com",
  },
];

const WEB_STEP: Extract<ToolCallCardStep, { kind: "web_search" }> = {
  kind: "web_search",
  title: "Searched the web",
  durationLabel: "1s",
  linkCount: 2,
  results: WEB_RESULTS,
};

const WEB_ERROR_STEP: Extract<
  ToolCallCardStep,
  { kind: "web_search_error" }
> = {
  kind: "web_search_error",
  title: "Web search failed",
  durationLabel: "1s",
  errorMessage: "Search provider unavailable",
};

/**
 * Collapsed — an inline "Web Search | <rotating chips>" link. The rotating
 * `WebsiteCarousel` cycles through the searched sites in the info slot; the
 * trailing down-chevron signals it expands in place.
 */
export const WebSearchCollapsed: Story = {
  args: {
    variant: "web",
    info: "Visit Toronto — Official Tourism",
    carouselItems: WEB_RESULTS,
    state: "complete",
    step: WEB_STEP,
    expanded: false,
    onExpandChange: () => {},
  },
};

/**
 * Expanded — the same link with the favicon result row revealed in place
 * beneath the header (and `+N more` overflow when clamped).
 */
export const WebSearchExpanded: Story = {
  args: {
    variant: "web",
    info: "Visit Toronto — Official Tourism",
    carouselItems: WEB_RESULTS,
    state: "complete",
    step: WEB_STEP,
    expanded: true,
    onExpandChange: () => {},
  },
};

/**
 * Loading — the "Web Search" label shimmers while the search is in flight.
 */
export const WebSearchLoading: Story = {
  args: {
    variant: "web",
    info: "Searching the web",
    carouselItems: WEB_RESULTS,
    state: "loading",
    step: WEB_STEP,
    expanded: false,
    onExpandChange: () => {},
  },
};

/**
 * Error — the header takes the negative tone and, when expanded, the step body
 * renders the error chip with the provider message.
 */
export const WebSearchError: Story = {
  args: {
    variant: "web",
    info: "Web search failed",
    carouselItems: [],
    state: "error",
    step: WEB_ERROR_STEP,
    expanded: true,
    onExpandChange: () => {},
  },
};
