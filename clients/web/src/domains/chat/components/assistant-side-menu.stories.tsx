/**
 * Visual reference for the sidebar's two conversation views.
 *
 * The section list is the one place where spacing, dividers, and header-menu
 * parity are easy to regress - Pinned, Chats, the per-channel sections, and
 * custom groups all render through one path but carry different data. These
 * stories mount the real `AssistantSideMenu` with a fixed conversation set so
 * those boundaries can be eyeballed side by side, in both the flat `All` view
 * and the channel-`Grouped` one.
 *
 * The view lives in the sidebar's layout store, keyed per assistant, so each
 * story seeds its own assistant id before mounting.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import {
  saveViewMode,
  type SidebarViewMode,
} from "@/domains/chat/utils/sidebar-view-mode";
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
    lastMessageAt: 60,
  }),
  conversation("r2", "Draft the launch email", { lastMessageAt: 40 }),
  conversation("r3", "Summarize yesterday's incident", { lastMessageAt: 10 }),

  conversation("s1", "#eng-alerts - deploy failed", {
    originChannel: "slack",
    lastMessageAt: 50,
  }),
  conversation("s2", "#design - icon set review", {
    originChannel: "slack",
    lastMessageAt: 30,
  }),

  conversation("t1", "Reminder: renew the domain", {
    originChannel: "telegram",
    lastMessageAt: 20,
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

/**
 * Enough conversations to run a list well past a screen. In the All view that
 * exercises the flat list's windowing against the sidebar's own scrollport;
 * in the Grouped view it exercises a single section hitting its height cap
 * and scrolling within itself.
 */
const LONG_CONVERSATIONS: Conversation[] = [
  ...CONVERSATIONS,
  ...Array.from({ length: 80 }, (_, index) =>
    conversation(`x${index}`, `Thread ${index + 1}`, {
      lastMessageAt: 9 - index,
    }),
  ),
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

/**
 * Seed the stored view mode so the story mounts straight into the view it
 * documents. The sidebar subscribes to storage during render, so the write is
 * all it takes; resetting the layout store clears any collapse state a
 * previously-rendered story left behind.
 */
function seedViewMode(assistantId: string, mode: SidebarViewMode): void {
  saveViewMode(assistantId, mode);
  useSidebarLayoutStore.setState({ assistantId: null });
}

const SHARED_ARGS = {
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
  // section: Pinned and Chats included.
  onMarkAllReadInGroup: () => {},
  onArchiveAllInGroup: () => {},
  onMarkConversationRead: () => {},
  onMarkConversationUnread: () => {},
  onPinConversation: () => {},
  onArchiveConversation: () => {},
} satisfies Partial<Parameters<typeof AssistantSideMenu>[0]>;

const meta: Meta<typeof AssistantSideMenu> = {
  title: "Chat/AssistantSideMenu",
  component: AssistantSideMenu,
  parameters: { layout: "fullscreen" },
  /* `--surface-base` is the app backdrop the sidebar sits on; `SideMenu`
     paints its own `--surface-overlay`, so the wrapper must not paint over
     it. The sidebar's own type and row metrics switch at `md`, so view these
     stories at a desktop viewport to see what desktop users see. */
  decorators: [
    (Story) => (
      <div className="flex h-screen bg-[var(--surface-base)]">
        <div className="w-[280px] shrink-0">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AssistantSideMenu>;

export const AllView: Story = {
  name: "All view (default)",
  beforeEach: () => seedViewMode("asst-all", "all"),
  args: { ...SHARED_ARGS, assistantId: "asst-all" },
};

export const AllViewLongList: Story = {
  name: "All view · long list",
  beforeEach: () => seedViewMode("asst-all-long", "all"),
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-all-long",
    conversations: LONG_CONVERSATIONS,
  },
};

export const GroupedLongSection: Story = {
  name: "Grouped view · long section",
  beforeEach: () => seedViewMode("asst-grouped-long", "grouped"),
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-grouped-long",
    conversations: LONG_CONVERSATIONS,
  },
};

export const GroupedView: Story = {
  name: "Grouped view",
  beforeEach: () => seedViewMode("asst-grouped", "grouped"),
  args: { ...SHARED_ARGS, assistantId: "asst-grouped" },
};
