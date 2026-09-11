/**
 * Design prototype: chat as a Slack-style DM with threads.
 *
 * One main conversation with the assistant. Reply to any message to open a
 * thread (a child conversation), so the sidebar of top-level chats goes away
 * and a "Threads" destination takes its place.
 *
 * Every story is fully interactive: send in the main conversation, hover a
 * message and pick "Reply in thread", send inside the thread, and use the
 * rail's Threads view to get back to older ones. The Controls panel drives
 * every visual decision, so a story is a starting point rather than a fixed
 * picture. The variants below differ only in their starting args.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  DEFAULT_THREADED_CHAT_OPTIONS,
  ThreadedChatPrototype,
} from "./threaded-chat-prototype";

const meta: Meta<typeof ThreadedChatPrototype> = {
  title: "Chat/Prototypes/Threaded Chat",
  component: ThreadedChatPrototype,
  // Each story owns its own conversation state, and a docs page that mounts
  // them all at once would run four mock assistants side by side.
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen" },
  args: { ...DEFAULT_THREADED_CHAT_OPTIONS, initialOpenThreadId: null },
  argTypes: {
    threadPresentation: {
      control: "radio",
      options: ["side-panel", "inline", "drill-in", "overlay"],
      description: "Where a thread opens.",
      table: { category: "Threads" },
    },
    threadIndicator: {
      control: "radio",
      options: ["pill", "line", "minimal"],
      description: "How a message with replies advertises its thread.",
      table: { category: "Threads" },
    },
    replyAffordance: {
      control: "radio",
      options: ["hover", "always"],
      description:
        "Reply only from the hover toolbar, or also from an always-visible link.",
      table: { category: "Threads" },
    },
    parentInThread: {
      control: "radio",
      options: ["quoted", "full", "hidden"],
      description: "How the parent message appears at the top of a thread.",
      table: { category: "Threads" },
    },
    threadPanelWidth: {
      control: { type: "range", min: 320, max: 720, step: 10 },
      description: "Side panel width. The panel is also drag-resizable.",
      table: { category: "Threads" },
    },
    accentThreads: {
      control: "boolean",
      description: "Thread lines and unread marks in the accent color.",
      table: { category: "Threads" },
    },
    messageStyle: {
      control: "radio",
      options: ["bubbles", "linear", "hybrid"],
      description:
        "bubbles = shipped look. linear = Slack rows. hybrid = Slack rows with tinted user rows.",
      table: { category: "Messages" },
    },
    density: {
      control: "radio",
      options: ["comfortable", "compact"],
      table: { category: "Messages" },
    },
    showAvatars: { control: "boolean", table: { category: "Messages" } },
    showTimestamps: { control: "boolean", table: { category: "Messages" } },
    groupConsecutive: {
      control: "boolean",
      description: "Collapse back-to-back messages from one author into a run.",
      table: { category: "Messages" },
    },
    showDateDividers: { control: "boolean", table: { category: "Messages" } },
    bubbleRadius: {
      control: { type: "range", min: 0, max: 24, step: 1 },
      description: "Corner radius of user bubbles and the composer.",
      table: { category: "Messages" },
    },
    leftRail: {
      control: "radio",
      options: ["none", "icons", "labeled"],
      description: "What replaces the conversations sidebar.",
      table: { category: "Layout" },
    },
    composerStyle: {
      control: "radio",
      options: ["card", "flat"],
      table: { category: "Layout" },
    },
    maxContentWidth: {
      control: { type: "range", min: 560, max: 1100, step: 10 },
      table: { category: "Layout" },
    },
    animationMs: {
      control: { type: "range", min: 0, max: 600, step: 20 },
      table: { category: "Layout" },
    },
    mockAssistantReplies: {
      control: "boolean",
      description: "Answer each send with a canned assistant reply.",
      table: { category: "Behavior" },
    },
    initialOpenThreadId: {
      control: "select",
      options: [null, "m4", "m6", "m8"],
      description:
        "Open this message's thread on load. In `thread` reply mode threads hang off the user messages (m1, m3, m5, m7, m9).",
      table: { category: "Behavior" },
    },
    assistantRepliesIn: {
      control: "radio",
      options: ["main", "thread"],
      description:
        "Where the assistant answers a top-level message. `thread` puts every answer in a thread on the user's message and swaps the seed.",
      table: { category: "Reply mode" },
    },
    replyPreview: {
      control: "radio",
      options: ["none", "snippet", "expanded-latest"],
      description:
        "In `thread` mode, how the answer shows under the user's message in the main feed.",
      table: { category: "Reply mode" },
    },
    previewLines: {
      control: { type: "range", min: 1, max: 8, step: 1 },
      description: "Lines of the answer a clamped preview shows.",
      table: { category: "Reply mode" },
    },
    followUpDefault: {
      control: "radio",
      options: ["thread", "new-topic"],
      description:
        "In `thread` mode, whether the main composer continues the thread the assistant just answered in.",
      table: { category: "Reply mode" },
    },
    seed: { table: { disable: true } },
  },
};

export default meta;
type Story = StoryObj<typeof ThreadedChatPrototype>;

/**
 * Slack's shape: the thread opens in a resizable panel beside the main
 * conversation, so both stay readable at once. Messages keep the shipped
 * bubble look.
 */
export const SidePanel: Story = {};

/**
 * Same panel, but every message drawn as a Slack row: avatar, name, time,
 * left-aligned. Consecutive messages collapse into runs. This is the
 * "we are a DM now" reading of the idea.
 */
export const SlackRows: Story = {
  args: {
    messageStyle: "linear",
    groupConsecutive: true,
    composerStyle: "flat",
    bubbleRadius: 8,
  },
};

/**
 * The thread unfolds under its parent, indented on a thread line, with its
 * own composer. Nothing leaves the main column, so the reader never loses
 * their place in it.
 */
export const Inline: Story = {
  args: {
    threadPresentation: "inline",
    threadIndicator: "line",
    messageStyle: "hybrid",
    parentInThread: "hidden",
  },
};

/**
 * The thread replaces the main column and a back chevron returns. The main
 * conversation slides away under it. This is the arrangement a phone gets
 * regardless, so it is worth seeing at desktop width too.
 */
export const DrillIn: Story = {
  args: {
    threadPresentation: "drill-in",
    parentInThread: "full",
    leftRail: "labeled",
  },
};

/**
 * The thread floats over the dimmed main conversation. Quick to glance at
 * and dismiss, at the cost of not seeing both at once.
 */
export const Overlay: Story = {
  args: {
    threadPresentation: "overlay",
    threadIndicator: "minimal",
    animationMs: 180,
  },
};

/**
 * Starts with the usage-numbers thread already open, with an unread reply.
 * Use it to tune the open state without clicking through.
 */
export const ThreadOpen: Story = {
  args: {
    initialOpenThreadId: "m6",
    accentThreads: true,
  },
};

/**
 * Tighter rows, always-visible reply links, and no date dividers, for the
 * densest reading of the layout.
 */
export const Compact: Story = {
  args: {
    density: "compact",
    messageStyle: "linear",
    groupConsecutive: true,
    replyAffordance: "always",
    showDateDividers: false,
    threadIndicator: "minimal",
    maxContentWidth: 900,
  },
};

/**
 * The assistant answers every top-level message inside a thread on it, so
 * the main feed is only what the user sent. To keep that from reading as a
 * list of unanswered questions, the answer peeks into the feed under the
 * message, clamped, drawn the way an assistant row normally looks, and the
 * composer follows the thread the assistant just answered in (the chip above
 * it backs out to a new topic).
 */
export const AssistantRepliesInThreadClamped: Story = {
  args: {
    assistantRepliesIn: "thread",
    replyPreview: "snippet",
    previewLines: 3,
    followUpDefault: "thread",
  },
};

/**
 * Same mode, but the newest exchange shows in full in the feed while older
 * ones clamp. The current turn reads exactly like chat; history folds up
 * behind it.
 */
export const AssistantRepliesInThread: Story = {
  args: {
    assistantRepliesIn: "thread",
    replyPreview: "expanded-latest",
    previewLines: 2,
    followUpDefault: "thread",
    threadIndicator: "minimal",
  },
};

/**
 * The bare version of the mode, without previews: what the feed looks like
 * when answers are only reachable through the thread pill. Kept as the
 * control for the two stories above.
 */
export const AssistantRepliesInThreadBare: Story = {
  args: {
    assistantRepliesIn: "thread",
    replyPreview: "none",
    followUpDefault: "new-topic",
  },
};

/**
 * Phone width. The side panel cannot fit, so this story starts on drill-in
 * with no rail; the rail would become a tab bar in a shipped version.
 */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  args: {
    threadPresentation: "drill-in",
    leftRail: "none",
    maxContentWidth: 600,
    parentInThread: "quoted",
  },
};
