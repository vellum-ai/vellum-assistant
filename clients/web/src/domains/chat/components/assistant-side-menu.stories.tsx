/**
 * Visual reference for the sidebar's conversation sections.
 *
 * The section list is the one place where spacing and header-menu parity are
 * easy to regress — Pinned, Chats, the per-channel sections, and custom
 * groups are rendered by the same component but wired from different call
 * sites. This story mounts the real `AssistantSideMenu` with a fixed
 * conversation set so those boundaries can be eyeballed side by side.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import type { Conversation } from "@/types/conversation-types";

function conversation(
  conversationId: string,
  title: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return { conversationId, title, ...overrides };
}

const CONVERSATIONS: Conversation[] = [
  conversation("p1", "Q3 planning doc", { isPinned: true, displayOrder: 0 }),
  conversation("p2", "Standup notes", { isPinned: true, displayOrder: 1 }),

  conversation("r1", "Refactor the billing client", {
    hasUnseenLatestAssistantMessage: true,
  }),
  conversation("r2", "Draft the launch email"),
  conversation("r3", "Summarize yesterday's incident"),

  conversation("s1", "#eng-alerts — deploy failed", { originChannel: "slack" }),
  conversation("s2", "#design — icon set review", { originChannel: "slack" }),

  conversation("t1", "Reminder: renew the domain", {
    originChannel: "telegram",
  }),
];

const meta: Meta<typeof AssistantSideMenu> = {
  title: "Chat/AssistantSideMenu",
  component: AssistantSideMenu,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof AssistantSideMenu>;

export const ConversationSections: Story = {
  name: "Conversation sections",
  render: (args) => (
    <div className="h-screen w-[280px] border-r border-[var(--border-default)] bg-[var(--surface-default)]">
      <AssistantSideMenu {...args} />
    </div>
  ),
  args: {
    assistantId: "asst-story",
    assistantName: "Vex",
    collapsed: false,
    variant: "rail",
    conversations: CONVERSATIONS,
    activeConversationId: "r1",
    onSelectConversation: () => {},
    onStartNewConversation: () => {},
    // Wiring the bulk handlers is what puts the header menu on every
    // section — Pinned and Chats included.
    onMarkAllReadInGroup: () => {},
    onArchiveAllInGroup: () => {},
    onMarkConversationRead: () => {},
    onMarkConversationUnread: () => {},
    onPinConversation: () => {},
    onArchiveConversation: () => {},
  },
};
