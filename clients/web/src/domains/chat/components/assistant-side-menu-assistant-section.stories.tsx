/**
 * The whole sidebar, with the assistant-initiated section in it.
 *
 * The section stories next door render one card. This renders the real
 * {@link AssistantSideMenu} — assistant pill, New Chat, every section, the
 * Preferences footer — so the section can be judged where it actually lives:
 * pinned at the foot of the list, directly above Preferences, with Chats
 * above it taking the leftover height.
 *
 * Nothing is stubbed at the component layer. The menu runs its own
 * `useSidebarState`, which reads the daemon's section index through
 * `useSidebarSectionsQuery`; seeding `sidebarSectionsQueryKey` makes that
 * query resolve from cache, so the section list here is the one the app
 * builds, in the order the app orders it. Each section's rows come from its
 * own `useSectionConversations`, seeded the same way. No network, no daemon,
 * no feature flag — the daemon's flag decides whether the `assistant` index
 * row exists, and seeding it is exactly the on state.
 *
 * Every seeded value is a production type (`SidebarIndexSection`,
 * `ConversationListPage`, `Conversation`), so a drift in any of those shapes
 * breaks this build rather than surfacing later in the app.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import type { Conversation } from "@/types/conversation-types";
import {
  SYSTEM_ALL_GROUP_ID,
  SYSTEM_ASSISTANT_GROUP_ID,
  SYSTEM_PINNED_GROUP_ID,
  sidebarSectionsQueryKey,
  type SidebarIndexSection,
} from "@/utils/conversation-list-fetchers";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";
import { listPage } from "@/utils/conversation-list.test-helper";

const ASSISTANT_ID = "asst-storybook";

/** The avatar accent the section tint reads. Swap to audit other colors. */
const ACCENT = "#C4436A";

/**
 * Threads the way a heartbeat realization actually reads — an observation the
 * user did not ask for, carrying the detail that makes it worth surfacing.
 */
const ASSISTANT_THREADS: Conversation[] = [
  {
    conversationId: "a1",
    title: "Your Tuesday reviews keep slipping past 6pm",
    hasUnseenLatestAssistantMessage: true,
  },
  {
    conversationId: "a2",
    title: "The contractor never sent the revised quote",
    hasUnseenLatestAssistantMessage: true,
  },
  {
    conversationId: "a3",
    title: "You've rewritten the same paragraph four times",
  },
];

const CHATS: Conversation[] = [
  { conversationId: "c1", title: "Fernweh Coffee landing page" },
  { conversationId: "c2", title: "Lease renewal" },
  { conversationId: "c3", title: "Weekend hike recommendations" },
  { conversationId: "c4", title: "Resume feedback" },
  {
    conversationId: "c5",
    title: "Weekly meal plan",
    hasUnseenLatestAssistantMessage: true,
  },
  { conversationId: "c6", title: "Home gym setup" },
  { conversationId: "c7", title: "Budget spreadsheet help" },
];

const PINNED: Conversation[] = [
  { conversationId: "p1", title: "Investor update draft", isPinned: true },
];

function seededClient(assistantThreads: Conversation[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });

  /* The section index: what the daemon serves from
     GET /v1/conversations/sections. The `assistant` row is emitted only under
     the `assistant-initiated-threads` flag, so its presence here *is* the
     flag being on. */
  const index: SidebarIndexSection[] = [
    { kind: "pinned", total: PINNED.length, unread: 0 },
    { kind: "chats", total: CHATS.length, unread: 1 },
    {
      kind: "assistant",
      total: assistantThreads.length,
      unread: assistantThreads.filter(
        (c) => c.hasUnseenLatestAssistantMessage === true,
      ).length,
    },
  ];
  client.setQueryData(sidebarSectionsQueryKey(ASSISTANT_ID), index);

  // Each section fetches its own rows; seed the key each one asks for.
  client.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, {
      groupId: SYSTEM_ASSISTANT_GROUP_ID,
    }),
    listPage(assistantThreads),
  );
  client.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, { groupId: SYSTEM_ALL_GROUP_ID }),
    listPage(CHATS),
  );
  client.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, { groupId: SYSTEM_PINNED_GROUP_ID }),
    listPage(PINNED),
  );

  return client;
}

function Scene({
  assistantThreads,
  assistantName,
}: {
  assistantThreads: Conversation[];
  assistantName: string | null;
}) {
  // Opens the per-section query gate (it checks the connected version).
  useAssistantIdentityStore
    .getState()
    .setIdentity(assistantName, "0.12.0", ASSISTANT_ID);
  // A clean layout store, so a stored section order from another story cannot
  // decide this one's arrangement.
  useSidebarLayoutStore.setState({
    assistantId: ASSISTANT_ID,
    openCategories: [],
    openCustomGroups: [],
    sectionOrder: [],
  });

  return (
    <QueryClientProvider client={seededClient(assistantThreads)}>
      {/* The rail's real height and width, so "pinned above Preferences" and
          the leftover-space split between Chats and this section are both
          visible rather than implied. */}
      <div
        style={{ height: 720, ["--avatar-accent" as string]: ACCENT }}
        className="flex w-[264px] flex-col"
      >
        <AssistantSideMenu
          assistantId={ASSISTANT_ID}
          assistantName={assistantName}
          conversations={[...CHATS, ...PINNED]}
          collapsed={false}
          variant="rail"
          onSelectConversation={() => {}}
          footerAction={
            <div className="rounded-full bg-[var(--surface-lift)] px-3 py-2 text-body-small-lighter text-[var(--content-secondary)]">
              Preferences
            </div>
          }
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Chat/AssistantSideMenuWithAssistantSection",
  component: Scene,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Scene>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The arrangement to judge: Pinned and Chats above, the assistant's own
 * section at the foot of the list directly above Preferences, tinted in the
 * avatar's color with the assistant's eyes where a topic glyph would sit.
 */
export const Default: Story = {
  args: { assistantThreads: ASSISTANT_THREADS, assistantName: "Ada" },
};

/** Before the assistant is named, the header falls back to "On My Mind". */
export const UnnamedAssistant: Story = {
  args: { assistantThreads: ASSISTANT_THREADS, assistantName: null },
};

/**
 * Nothing yet. The section still renders — its empty state is what explains
 * it to someone who has no threads — and Chats keeps the leftover height.
 */
export const EmptySection: Story = {
  args: { assistantThreads: [], assistantName: "Ada" },
};
