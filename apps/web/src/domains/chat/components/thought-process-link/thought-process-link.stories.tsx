import type { Meta, StoryObj } from "@storybook/react-vite";

import { useViewerStore } from "@/stores/viewer-store";

import { ThoughtProcessLink } from "./thought-process-link";

const REASONING =
  "The user is asking for a summary of the recent activity. Let me think " +
  "through what's changed: there are a handful of uncommitted edits in the " +
  "web app, and the most relevant ones touch the chat transcript. I'll " +
  "highlight those before drilling into specifics.";

const meta: Meta<typeof ThoughtProcessLink> = {
  title: "Chat/ThoughtProcessLink",
  component: ThoughtProcessLink,
  parameters: {
    layout: "padded",
  },
  argTypes: {
    content: { control: "text" },
    isStreaming: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof ThoughtProcessLink>;

export const Default: Story = {
  args: {
    content: REASONING,
  },
};

/**
 * Streaming — the link owns the loading state: the brain glyph is swapped for
 * the shared three-dot indicator and the label reads "Thinking". It stays
 * clickable so the reasoning-so-far opens in the drawer mid-stream.
 */
export const Streaming: Story = {
  args: {
    content: REASONING,
    isStreaming: true,
  },
};

/**
 * Streaming, before any reasoning text has landed. The link still renders (so
 * it can be the single thinking affordance from the very start of the turn) —
 * dots + "Thinking", with an empty drawer until content arrives.
 */
export const StreamingEmpty: Story = {
  args: {
    content: "",
    isStreaming: true,
  },
};

/**
 * Active state — the link whose reasoning is currently open in the side
 * drawer renders its label in `--content-default`. The decorator primes the
 * viewer store with a matching thinking payload on mount.
 */
export const Active: Story = {
  args: {
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
