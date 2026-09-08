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
 * own `useSectionConversations`, seeded the same way, and the avatar query is
 * seeded with a real character from the bundled catalog so the switcher pill
 * and the accent tint are the avatar's own. No network, no daemon, no feature
 * flag - the daemon's flag decides whether the `assistant` index row exists,
 * and seeding it is exactly the on state.
 *
 * Every seeded value is a production type (`SidebarIndexSection`,
 * `ConversationListPage`, `Conversation`), so a drift in any of those shapes
 * breaks this build rather than surfacing later in the app.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { avatarQueryKey, type AvatarData } from "@/hooks/use-assistant-avatar";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import type { CharacterTraits } from "@/types/avatar";
import type { Conversation } from "@/types/conversation-types";
import { resolveAvatarAccentHex } from "@/utils/avatar-accent";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
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

/**
 * A real character avatar from the bundled catalog, so the switcher pill's
 * avatar and the section tint come from one identity. Swap the `color` id to
 * audit the tint against other palette entries; the accent is derived from
 * it, so the two cannot drift apart.
 */
const AVATAR_TRAITS: CharacterTraits = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "pink",
};

/**
 * The exact hex `useAvatarAccentVar` would publish for these traits. The hook
 * lives in `RootLayout`, which stories do not mount, so the wrapper publishes
 * the var itself, but derived rather than hand-picked: the tint under review
 * is the one this avatar actually produces. (`?? undefined` only narrows the
 * unreachable null arm; the trait color is a bundled palette id.)
 */
const ACCENT =
  resolveAvatarAccentHex({
    components: BUNDLED_COMPONENTS,
    traits: AVATAR_TRAITS,
    customImageUrl: null,
  }) ?? undefined;

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
  {
    conversationId: "a4",
    title: "Two of your integrations have been quiet for a while",
  },
  {
    conversationId: "a5",
    title: "Overnight: a pattern in what you keep deferring",
  },
  {
    conversationId: "a6",
    title: "The gym sessions moved to mornings and stuck",
  },
  {
    conversationId: "a7",
    title: "Your reading list doubled this month",
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

  /* The avatar, so the switcher pill's character renders. Both spellings of
     the key carry it, since the hook appends its manifest-support flag and a
     story cannot know which way that resolves (same pattern as
     assistant-switcher.stories). */
  for (const supportsManifest of [true, false]) {
    client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
      components: BUNDLED_COMPONENTS,
      traits: AVATAR_TRAITS,
      customImageUrl: null,
    } satisfies AvatarData);
  }

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
  /* The other half of that gate: `useSectionConversations` serves a section's
     own query only while the assistant is active (`live`), and falls back to
     the derived rows (empty here) otherwise. The store boots as `loading`,
     which read as an assistant section with no threads. */
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "active", isLocal: true },
  });
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
            /* Stands at the real footer's height: the app's Preferences
               trigger is a `PanelItem` pill at
               `h-[var(--side-menu-tile-size,36px)]`, and the height
               comparisons this story exists for (the assistant header pill,
               the collapsed section pills) are against that 36px, so a
               content-sized mock here would misreport them. */
            <div className="flex h-9 items-center rounded-full bg-[var(--surface-lift)] px-3 text-body-small-lighter text-[var(--content-secondary)]">
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
