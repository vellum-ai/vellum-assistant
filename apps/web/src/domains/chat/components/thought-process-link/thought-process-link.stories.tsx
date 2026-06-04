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

export const Streaming: Story = {
  args: {
    content: REASONING,
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
