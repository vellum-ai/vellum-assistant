/**
 * The sidebar under `sidebar-done`.
 *
 * The real `AssistantSideMenu` with the flag forced on, so what is on screen
 * is the shipped sidebar rather than a mock of it: the row's trailing control
 * is a Done check, the section headers carry "View all chats" beside their
 * "…", and the Expand control is gone.
 *
 * The archive is wired to story-local state, so checking a row really removes
 * it. That is the whole interaction under review, and a story that stubbed it
 * would show the affordance without showing what it does.
 *
 * `FlagOff` is the control: the same fixture with the flag down, which has to
 * render today's sidebar, ellipsis and Expand included.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import { DRAWER_SURFACE_BACKGROUND } from "@/domains/chat/utils/drawer-surface";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { saveViewMode } from "@/domains/chat/utils/sidebar-view-mode";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 18, 16, 30);
const HOUR = 3_600_000;

function conversation(
  conversationId: string,
  title: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return { conversationId, title, ...overrides };
}

/* One of every section the flag touches: Pinned (a check, no view-all), a
   custom group, Chats, and a channel section. */
const CONVERSATIONS: Conversation[] = [
  conversation("p1", "Q3 planning doc", { isPinned: true, displayOrder: 0 }),

  conversation("r1", "Morning briefing", { lastMessageAt: NOW - 8 * HOUR }),
  conversation("r2", "Draft the launch email", {
    lastMessageAt: NOW - 5 * HOUR,
  }),
  conversation("r3", "Usage numbers for the quarter", {
    lastMessageAt: NOW - 3 * HOUR,
  }),
  conversation("r4", "Launch review brief", {
    lastMessageAt: NOW - HOUR,
    hasUnseenLatestAssistantMessage: true,
  }),
  conversation("r5", "Is the build green after the auth change?", {
    lastMessageAt: NOW - 10 * 60_000,
  }),

  conversation("g1", "Auth rewrite - PR #412", {
    groupId: "grp-reviews",
    displayOrder: 0,
  }),
  conversation("g2", "Search relevance - PR #418", {
    groupId: "grp-reviews",
    displayOrder: 1,
  }),

  conversation("s1", "#eng-alerts - deploy failed", {
    originChannel: "slack",
    lastMessageAt: NOW - 2 * HOUR,
  }),
  conversation("s2", "#design - icon set review", {
    originChannel: "slack",
    lastMessageAt: NOW - 6 * HOUR,
    hasUnseenLatestAssistantMessage: true,
  }),
];

/** Past the windowing threshold, where the Chats section is virtualized. */
const MANY_CONVERSATIONS: Conversation[] = [
  ...CONVERSATIONS,
  ...Array.from({ length: 60 }, (_, index) =>
    conversation(`x${index}`, `Thread ${index + 1}`, {
      lastMessageAt: NOW - (index + 12) * HOUR,
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
];

// ---------------------------------------------------------------------------
// Story scaffolding, mirroring `assistant-side-menu.stories.tsx`
// ---------------------------------------------------------------------------

/** One client per story assistant, so a seeded list is not refetched. */
const storyClients = new Map<string, QueryClient>();

function storyClient(assistantId: string): QueryClient {
  const existing = storyClients.get(assistantId);
  if (existing) {
    return existing;
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    appsGetQueryKey({ path: { assistant_id: assistantId } }),
    { apps: [] },
  );
  client.setQueryData(["assistant-capability", "appPins", assistantId], true);
  storyClients.set(assistantId, client);
  return client;
}

/**
 * Seed everything the sidebar reads from stores rather than props, and force
 * the flag. Returns the teardown Storybook runs between stories, so a story
 * with the flag on cannot leak it into the one after it.
 */
function seed(assistantId: string, sidebarDone: boolean) {
  saveViewMode(assistantId, "grouped");
  useSidebarLayoutStore.setState({ assistantId: null });
  useAuthStore.setState({ sessionStatus: "authenticated" });
  useResolvedAssistantsStore.setState({ activeAssistantId: assistantId });
  const previous = useClientFeatureFlagStore.getState().sidebarDone;
  useClientFeatureFlagStore.setState({ sidebarDone });
  return () => {
    useClientFeatureFlagStore.setState({ sidebarDone: previous });
  };
}

/**
 * The sidebar over a story-local conversation list, so the check really
 * removes a row. `onArchiveConversation` is the same callback `chat-layout`
 * wires to the archive mutation; here it is a `setState`.
 */
function LiveSidebar({
  assistantId,
  seedConversations,
  variant,
}: {
  assistantId: string;
  seedConversations: Conversation[];
  variant: "rail" | "overlay";
}) {
  const [conversations, setConversations] = useState(seedConversations);

  const patch = useCallback(
    (conversationId: string, changes: Partial<Conversation>) => {
      setConversations((previous) =>
        previous.map((row) =>
          row.conversationId === conversationId ? { ...row, ...changes } : row,
        ),
      );
    },
    [],
  );

  return (
    <AssistantSideMenu
      assistantId={assistantId}
      assistantName="Vex"
      collapsed={false}
      variant={variant}
      width={variant === "rail" ? 280 : undefined}
      onWidthChange={variant === "rail" ? () => {} : undefined}
      conversations={conversations}
      conversationGroups={GROUPS}
      activeConversationId="r4"
      onSelectConversation={() => {}}
      onOpenIntelligence={() => {}}
      onOpenApp={() => {}}
      onStartNewConversation={() => {}}
      onRenameGroup={() => {}}
      onDeleteGroup={() => {}}
      onCreateGroup={() => {}}
      onMarkAllReadInGroup={() => {}}
      onArchiveAllInGroup={() => {}}
      onMarkConversationRead={() => {}}
      onMarkConversationUnread={() => {}}
      onPinConversation={() => {}}
      onRenameConversation={() => {}}
      onDeleteConversation={() => {}}
      onArchiveConversation={(row) =>
        patch(row.conversationId, { archivedAt: Date.now() })
      }
      onUnarchiveConversation={(row) =>
        patch(row.conversationId, { archivedAt: undefined })
      }
      onClose={variant === "overlay" ? () => {} : undefined}
      footerAction={
        <PreferencesMenu
          assistantId={assistantId}
          triggerVariant={variant === "overlay" ? "pill" : undefined}
        />
      }
    />
  );
}

const meta: Meta<typeof LiveSidebar> = {
  title: "Chat/Sidebar Done",
  component: LiveSidebar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story, context) => (
      <QueryClientProvider
        client={storyClient(String(context.args.assistantId ?? ""))}
      >
        <Story />
      </QueryClientProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof LiveSidebar>;

/* `chat-layout`'s desktop shell, class for class, so the rail's spacing
   against the window edge is the app's own. */
function withDesktopShell(Story: () => React.ReactElement) {
  return (
    <div className="flex h-screen gap-4 bg-[var(--surface-base)] p-4">
      <aside className="w-fit shrink-0 overflow-hidden">
        <Story />
      </aside>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" />
    </div>
  );
}

export const Default: Story = {
  name: "Flag on",
  decorators: [withDesktopShell],
  beforeEach: () => seed("asst-done", true),
  args: {
    assistantId: "asst-done",
    seedConversations: CONVERSATIONS,
    variant: "rail",
  },
};

/**
 * Past the windowing threshold. The Chats section is virtualized here, and a
 * checked row slides out and closes the same way it does in a short list.
 */
export const ManyRows: Story = {
  name: "Flag on · windowed list",
  decorators: [withDesktopShell],
  beforeEach: () => seed("asst-done-many", true),
  args: {
    assistantId: "asst-done-many",
    seedConversations: MANY_CONVERSATIONS,
    variant: "rail",
  },
};

/** The control: today's sidebar, ellipsis and Expand included. */
export const FlagOff: Story = {
  name: "Flag off (unchanged)",
  decorators: [withDesktopShell],
  beforeEach: () => seed("asst-done-off", false),
  args: {
    assistantId: "asst-done-off",
    seedConversations: MANY_CONVERSATIONS,
    variant: "rail",
  },
};

/**
 * The mobile drawer. There is no hover, so the header's "View all chats" is
 * the first item in the section's own sheet instead of a second glyph, and
 * the row keeps its swipe and long-press rather than gaining a check.
 */
export const Mobile: Story = {
  name: "Flag on · mobile drawer",
  parameters: { layout: "centered" },
  beforeEach: () => seed("asst-done-mobile", true),
  decorators: [
    (Story) => (
      <div className="relative h-[874px] w-[402px] overflow-hidden bg-[var(--surface-base)]">
        <aside
          className="absolute inset-0 flex flex-col"
          style={{ background: DRAWER_SURFACE_BACKGROUND }}
        >
          <Story />
        </aside>
      </div>
    ),
  ],
  args: {
    assistantId: "asst-done-mobile",
    seedConversations: CONVERSATIONS,
    variant: "overlay",
  },
};

/** Every chat in Chats marked done: what the section says once it is clear. */
export const ChatsEmpty: Story = {
  name: "Flag on · Chats empty",
  decorators: [withDesktopShell],
  beforeEach: () => seed("asst-done-empty", true),
  args: {
    assistantId: "asst-done-empty",
    seedConversations: CONVERSATIONS.filter(
      (row) => !row.conversationId.startsWith("r"),
    ),
    variant: "rail",
  },
};

/** No chats at all, before the flag: a new assistant's first sidebar. */
export const ChatsEmptyFlagOff: Story = {
  name: "Flag off · no chats yet",
  decorators: [withDesktopShell],
  beforeEach: () => seed("asst-done-empty-off", false),
  args: {
    assistantId: "asst-done-empty-off",
    seedConversations: [],
    variant: "rail",
  },
};
