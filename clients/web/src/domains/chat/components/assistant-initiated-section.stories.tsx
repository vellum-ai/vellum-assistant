/**
 * The assistant-initiated sidebar section, rendered the way the app renders
 * it — no daemon, no gateway, no network.
 *
 * These mount the REAL {@link SidebarSectionItem}, which is what the sidebar
 * mounts: it resolves the header from the assistant identity store, fetches
 * its rows through `useSectionConversations`, and paints the avatar tint and
 * the empty state itself. Nothing here hand-assembles a card, so what you see
 * is what the sidebar draws.
 *
 * The rows come from a pre-seeded React Query cache rather than a mock
 * transport. `useSectionConversations` reads
 * `conversationListQueryKey(assistantId, {groupId: "system:assistant"})`, so
 * seeding that key with a `ConversationListPage` makes the query resolve from
 * cache and never open a request. The values are the production types
 * (`Conversation`, `ConversationListPage`), so a shape that drifts from what
 * the app reads fails the build here rather than looking fine in Storybook and
 * breaking in the app.
 *
 * The avatar query is seeded with a real character from the bundled catalog,
 * so the tint under review comes from an actual palette color.
 * `--avatar-accent` is published on `<html>` by
 * `useAvatarAccentVar` in the real app; Storybook does not mount `RootLayout`,
 * so each story sets it on its own wrapper, derived from the same traits.
 * Change the trait `color` id to audit the tint against other palette colors;
 * the light end (yellow) is the one worth checking, since the mix has to stay
 * distinguishable from a plain card without reading as a highlight.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import { SidebarSectionItem } from "@/domains/chat/components/sidebar-section-item";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { avatarQueryKey, type AvatarData } from "@/hooks/use-assistant-avatar";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { CharacterTraits } from "@/types/avatar";
import type { Conversation } from "@/types/conversation-types";
import { resolveAvatarAccentHex } from "@/utils/avatar-accent";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { SYSTEM_ASSISTANT_GROUP_ID } from "@/utils/conversation-list-fetchers";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";
import { listPage } from "@/utils/conversation-list.test-helper";

const ASSISTANT_ID = "asst-storybook";

/**
 * A real character avatar from the bundled catalog: the tint renders from its
 * palette color. Swap the `color` id to audit other palette entries; the
 * accent below is derived, so they cannot drift.
 */
const AVATAR_TRAITS: CharacterTraits = {
  bodyShape: "blob",
  eyeStyle: "curious",
  color: "pink",
};

/**
 * The exact hex `useAvatarAccentVar` would publish for these traits.
 * (`?? undefined` only narrows the unreachable null arm; the trait color is a
 * bundled palette id.)
 */
const ACCENT =
  resolveAvatarAccentHex({
    components: BUNDLED_COMPONENTS,
    traits: AVATAR_TRAITS,
    customImageUrl: null,
  }) ?? undefined;

/**
 * Threads written the way a heartbeat realization actually reads — an
 * observation the user did not ask for, carrying the specific detail that
 * makes it worth surfacing. Lorem text would make the section look better
 * than it is.
 */
const THREADS: Conversation[] = [
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
    hasUnseenLatestAssistantMessage: false,
  },
  {
    conversationId: "a4",
    title: "Two of your integrations have been quiet for a while",
    hasUnseenLatestAssistantMessage: false,
  },
  {
    conversationId: "a5",
    title: "Overnight: a pattern in what you keep deferring",
    hasUnseenLatestAssistantMessage: false,
  },
];

const CHATS: Conversation[] = [
  { conversationId: "c1", title: "Lease renewal" },
  { conversationId: "c2", title: "Weekly meal plan" },
  { conversationId: "c3", title: "Resume feedback" },
];

function assistantSection(): SidebarSection {
  return { type: "assistant", key: "assistant", label: "On My Mind", all: [] };
}

function chatsSection(): SidebarSection {
  return {
    type: "recents",
    key: "recents",
    label: "Chats",
    all: CHATS,
    holdsChannels: true,
  };
}

/**
 * A client whose caches are already populated, so every section query resolves
 * from cache on first render and opens no request.
 */
function seededClient(
  threads: Conversation[],
  withCharacterAvatar: boolean,
): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  client.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, {
      groupId: SYSTEM_ASSISTANT_GROUP_ID,
    }),
    listPage(threads),
  );
  client.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, { groupId: "system:all" }),
    listPage(CHATS),
  );
  if (withCharacterAvatar) {
    /* Both spellings of the key, since the hook appends its manifest-support
       flag and a story cannot know which way that resolves (same pattern as
       assistant-switcher.stories). */
    for (const supportsManifest of [true, false]) {
      client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
        components: BUNDLED_COMPONENTS,
        traits: AVATAR_TRAITS,
        customImageUrl: null,
      } satisfies AvatarData);
    }
  }
  return client;
}

/** Opens the per-section query gate, which checks the connected version. */
function openGate(name: string | null): void {
  useAssistantIdentityStore
    .getState()
    .setIdentity(name, "0.12.0", ASSISTANT_ID);
  /* The other half of that gate: `useSectionConversations` serves a section's
     own query only while the assistant is active (`live`), and falls back to
     the derived rows (empty here) otherwise. The store boots as `loading`,
     which read as an assistant section with no threads. */
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "active", isLocal: true },
  });
}

const LIST_CONTEXT: React.ComponentProps<
  typeof ConversationListProvider
>["value"] = {
  overlayCards: false,
  processingConversationIds: new Set<string>(),
  attentionConversationIds: new Set<string>(),
  onSelect: () => {},
};

function Scene({
  threads,
  assistantName,
  withNeighbour = true,
  withCharacterAvatar = true,
}: {
  threads: Conversation[];
  assistantName: string | null;
  withNeighbour?: boolean;
  /**
   * `false` is the custom-image / still-loading avatar: no seeded character,
   * and no published accent var, exactly as `useAvatarAccentVar` leaves it.
   */
  withCharacterAvatar?: boolean;
}) {
  openGate(assistantName);
  return (
    <QueryClientProvider client={seededClient(threads, withCharacterAvatar)}>
      <ConversationListProvider value={LIST_CONTEXT}>
        {/* The rail's real width, so title truncation reads truthfully. */}
        <div
          style={{
            width: 248,
            ["--avatar-accent" as string]: withCharacterAvatar
              ? ACCENT
              : undefined,
          }}
          className="flex flex-col gap-2"
        >
          <CollapsibleNavSection.Root
            type="multiple"
            defaultValue={["assistant", "recents"]}
          >
            <SidebarSectionItem
              section={assistantSection()}
              assistantId={ASSISTANT_ID}
              groupMenu={() => ({})}
            />
            {withNeighbour ? (
              <SidebarSectionItem
                section={chatsSection()}
                assistantId={ASSISTANT_ID}
                groupMenu={() => ({})}
              />
            ) : null}
          </CollapsibleNavSection.Root>
        </div>
      </ConversationListProvider>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Chat/AssistantInitiatedSection",
  component: Scene,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Scene>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The section beside Chats, which is the comparison that matters: the tint has
 * to read as "this one is different" without reading as "this one is
 * selected".
 */
export const InContext: Story = {
  args: { threads: THREADS, assistantName: "Ada" },
};

/** Named assistant, alone, for a closer look at the tint and header. */
export const Alone: Story = {
  args: { threads: THREADS, assistantName: "Ada", withNeighbour: false },
};

/**
 * Before the assistant has a name. "From Your Assistant" reads as a settings
 * row rather than a byline, so the unnamed case falls back to a neutral
 * header.
 */
export const Unnamed: Story = {
  args: { threads: THREADS, assistantName: null },
};

/**
 * Nothing yet — the state the section spends its first days in, and the only
 * reason it renders at zero at all. Copy alone under the header: the
 * section's Inbox mark already stands a line above, and the eyes and brain
 * belong to the assistant cluster at the top of the rail.
 */
export const Empty: Story = {
  args: { threads: [], assistantName: "Ada" },
};

/**
 * The custom-image / still-loading degradation: no accent var is published,
 * so the card and header fall back to the plain lifted surface.
 */
export const EmptyCustomImageAvatar: Story = {
  args: { threads: [], assistantName: "Ada", withCharacterAvatar: false },
};
