/**
 * Visual reference for the sidebar's conversation sections.
 *
 * The section list is the one place where spacing, dividers, and header-menu
 * parity are easy to regress - Pinned, Chats, the per-channel sections, and
 * custom groups all render through one path but carry different data. This
 * story mounts the real `AssistantSideMenu` with a fixed conversation set so
 * those boundaries can be eyeballed side by side.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";

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

  conversation("g1", "Auth rewrite - PR #412", {
    groupId: "grp-reviews",
    displayOrder: 0,
  }),
  conversation("g2", "Search relevance - PR #418", {
    groupId: "grp-reviews",
    displayOrder: 1,
  }),
  conversation("g3", "Prompt caching benchmark", {
    groupId: "grp-experiments",
    displayOrder: 0,
  }),
];

const GROUPS: ConversationGroup[] = [
  {
    id: "grp-reviews",
    name: "PR Reviews",
    icon: "code",
    sortPosition: 0,
    isSystemGroup: false,
  },
  {
    id: "grp-experiments",
    name: "Experiments",
    icon: "lightbulb",
    sortPosition: 1,
    isSystemGroup: false,
  },
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
  /* `--surface-base` is the app backdrop the sidebar sits on; `SideMenu`
     paints its own `--surface-overlay`, so the wrapper must not paint over
     it. (This previously read `--surface-default` / `--border-default`,
     neither of which is a real token - the background silently fell through
     to transparent and `border-[var(--border-default)]` resolved to
     `currentColor`, drawing a near-black rule that looks nothing like the
     app.) The sidebar's own type and row metrics switch at `md`, so view
     this story at a desktop viewport to see what desktop users see. */
  render: (args) => (
    <div className="flex h-screen bg-[var(--surface-base)]">
      <div className="w-[280px] shrink-0">
        <AssistantSideMenu {...args} />
      </div>
    </div>
  ),
  args: {
    assistantId: "asst-story",
    assistantName: "Vex",
    collapsed: false,
    variant: "rail",
    conversations: CONVERSATIONS,
    conversationGroups: GROUPS,
    activeConversationId: "r1",
    onSelectConversation: () => {},
    onStartNewConversation: () => {},
    onRenameGroup: () => {},
    onDeleteGroup: () => {},
    onReorderConversations: () => {},
    // Wires the list's right-click "New group…". Omitting it drops the
    // affordance entirely, so the story has to pass it to show the menu.
    onCreateGroup: () => {},
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
