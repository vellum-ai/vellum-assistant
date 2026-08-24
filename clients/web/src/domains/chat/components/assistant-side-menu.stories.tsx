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
 * story seeds its own assistant id before mounting. Pinned apps arrive on the
 * daemon's app list rather than as a prop, so each story also gets a query
 * client carrying that list for the assistant it renders.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import { Button } from "@vellumai/design-library";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import type { AvatarData } from "@/hooks/use-assistant-avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import { DRAWER_SURFACE_BACKGROUND } from "@/domains/chat/utils/drawer-surface";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAuthStore } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { AppSummary } from "@/types/app-types";
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

/* Two, because one pinned app cannot show whether the cluster spaces its
   entries the way the sections below it do.

   One coloured and one not, because the pair is what shows the wash reading as
   a tint of the pill it sits on rather than as a different component, and what
   shows the two of them still reading as quieter than the assistant identity
   pill above them. */
/* Pins ride on the app list the daemon serves, so the fixture is apps rather
   than a separate pin record. */
const PINNED_APPS: AppSummary[] = [
  {
    id: "app-ops",
    name: "Vex Ops",
    createdAt: 0,
    updatedAt: 0,
    version: "1",
    contentId: "content-ops",
    origin: "workspace",
    pinSortPosition: 1,
    pinColor: "teal",
  },
  {
    id: "app-inbox",
    name: "Inbox Triage",
    createdAt: 0,
    updatedAt: 0,
    version: "1",
    contentId: "content-inbox",
    origin: "workspace",
    pinSortPosition: 2,
  },
];

/**
 * Seed the app list the sidebar's pinned block reads, and the capability that
 * decides it reads from there at all. Without the capability the sidebar falls
 * back to the browser-local pin list, so these stories would document a path
 * they do not mean to show.
 */
function seedApps(client: QueryClient, assistantId: string): QueryClient {
  client.setQueryData(
    appsGetQueryKey({ path: { assistant_id: assistantId } }),
    {
      apps: PINNED_APPS,
    },
  );
  client.setQueryData(["assistant-capability", "appPins", assistantId], true);
  return client;
}

/**
 * One client per story assistant, kept across re-renders so a seeded list is
 * not rebuilt (and refetched) underneath the story on every render.
 */
const storyClients = new Map<string, QueryClient>();

function storyClient(assistantId: string): QueryClient {
  const existing = storyClients.get(assistantId);
  if (existing) {
    return existing;
  }
  const client = seedApps(
    new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    }),
    assistantId,
  );
  storyClients.set(assistantId, client);
  return client;
}

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
  /* A custom group the user has not filed anything into yet, given no
     conversations on purpose: an empty section renders in both states - a
     muted tile on the rail, a headed card when expanded - and it holds its
     place either way. In the shared set rather than one story, so the
     collapsed and expanded stories differ only by `collapsed`.

     Not named "Archive": archived conversations are excluded from the sidebar
     entirely (`groupConversations` drops anything with `archivedAt`), so a
     fixture called that reads as a section this component renders and never
     does. */
  {
    id: "grp-reading",
    name: "Reading List",
    icon: "bookmark",
    sortPosition: 2,
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
  /* `PreferencesMenu` renders nothing for a signed-out user and a story has no
     session of its own, so the sidebar's footer entry only appears in these
     stories once one is seeded. */
  useAuthStore.setState({ sessionStatus: "authenticated" });
  /* `useAssistantCapability` keys on the active assistant from this store, not
     on the id the story passes as a prop, so the seeded `appPins` answer is
     only found once the store agrees which assistant is active. */
  useResolvedAssistantsStore.setState({ activeAssistantId: assistantId });
}

/**
 * Seeds the cache the identity row's avatar hook reads.
 *
 * That row takes an assistant id and fetches its own avatar rather than being
 * handed one, so a story seeding nothing renders the row's no-avatar fallback:
 * a Brain glyph on a plain pill. The row is correct on the data it has, which
 * puts the eyes, the avatar tint and the uploaded-image treatment out of reach
 * of any story that does not seed.
 *
 * Each story owns its client, so a seed cannot leak into its neighbours, and
 * both spellings of the key carry it: the hook appends its manifest-support
 * flag and a story cannot know which way that resolves.
 */
function seededAvatarClient(
  assistantId: string,
  data: AvatarData,
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  for (const supportsManifest of [true, false]) {
    client.setQueryData(
      [...avatarQueryKey(assistantId), supportsManifest],
      data,
    );
  }
  return seedApps(client, assistantId);
}

/* A stand-in for an uploaded photo, inline so the story needs no network and
   works offline. Any image URL the daemon serves renders the same way. */
const UPLOADED_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23d9713f'/%3E%3Ccircle cx='22' cy='24' r='11' fill='%236b2f1f' opacity='0.6'/%3E%3Cpath d='M2 62c9-17 24-23 37-16 8 4 17 10 25 16z' fill='%232c1710' opacity='0.45'/%3E%3C/svg%3E";

const IMAGE_AVATAR_CLIENT = seededAvatarClient("asst-image", {
  components: null,
  traits: null,
  customImageUrl: UPLOADED_IMAGE,
});

const CHARACTER_AVATAR_CLIENT = seededAvatarClient("asst-character", {
  components: BUNDLED_COMPONENTS,
  traits: { bodyShape: "blob", eyeStyle: "curious", color: "purple" },
  customImageUrl: null,
});

function withAvatar(client: QueryClient) {
  return function AvatarDecorator(Story: () => React.ReactElement) {
    return (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    );
  };
}

const SHARED_ARGS = {
  assistantName: "Vex",
  collapsed: false,
  variant: "rail",
  /* `chat-layout` always hands the expanded rail a width and a width setter,
     which is what mounts the drag-resize handle at the rail's edge. Omitting
     them renders a rail the app never shows, and hides the handle's overlap
     with whatever sits against that edge. */
  width: 280,
  onWidthChange: () => {},
  conversations: CONVERSATIONS,
  conversationGroups: GROUPS,
  activeConversationId: "r1",
  onSelectConversation: () => {},
  /* `PanelItem` only takes on button semantics, hover and a pointer cursor
     when it is given a handler. Without these two the assistant row and the
     pinned apps render inert, which reads as a styling bug in the pill and
     is not one. */
  onOpenIntelligence: () => {},
  onOpenApp: () => {},
  onStartNewConversation: () => {},
  onRenameGroup: () => {},
  onDeleteGroup: () => {},
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
  onDeleteConversation: () => {},
  /* The real `PreferencesMenu`, not a stand-in: it is the sidebar's bottom
     entry, and without it these stories show every part of the rail except
     the one at its foot. `chat-layout` passes it the same way. */
  footerAction: <PreferencesMenu assistantId="asst-story" />,
} satisfies Partial<Parameters<typeof AssistantSideMenu>[0]>;

const meta: Meta<typeof AssistantSideMenu> = {
  title: "Chat/AssistantSideMenu",
  component: AssistantSideMenu,
  parameters: { layout: "fullscreen" },
  /* The wrapper is `chat-layout`'s desktop shell, class for class: the
     `gap-4 p-4` flex row on the `--surface-base` page background, the
     shrink-wrapped `overflow-hidden` aside the rail sizes, and the
     transparent `<main>` beside it, which carries no surface of its own -
     the transcript inside it does. The rail's spacing against the window
     edges and against the content area is then the app's own, so a story
     shows the geometry desktop users get rather than a frame invented for
     the story. `<main>` is left empty: the chat body is a separate domain
     and mounting it would make these stories depend on it. The sidebar's
     type and row metrics switch at `md`; the desktop width every story
     starts at holds these above that breakpoint. */
  decorators: [
    (Story, context) => (
      <QueryClientProvider
        client={storyClient(String(context.args.assistantId ?? ""))}
      >
        <Story />
      </QueryClientProvider>
    ),
    (Story) => (
      <div className="flex h-screen gap-4 bg-[var(--surface-base)] p-4">
        <aside className="w-fit shrink-0 overflow-hidden">
          <Story />
        </aside>
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" />
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

/* The collapsed rail: one circle per section, each carrying the same
   indicator its expanded header shows. The rail's geometry only exists at
   this width, and it is where the last two geometry bugs shipped, so it gets
   its own surface rather than living as a control on another story.

   "Archive" is seeded with no conversations to draw the empty-section tile:
   still a circle in the column and still a hover target, so the tooltip
   explaining why it does nothing stays reachable. It's muted rather than
   natively disabled for exactly that reason. */
export const CollapsedRail: Story = {
  name: "Collapsed rail · grouped view",
  beforeEach: () => seedViewMode("asst-collapsed", "grouped"),
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-collapsed",
    collapsed: true,
    footerAction: <PreferencesMenu assistantId="asst-story" />,
  },
};

/* The same rail in the default view, which is the one most users see. The two
   views put a different section set in the column, and the rail is where a
   section list going wrong is hardest to spot, so each view gets its own
   collapsed surface rather than sharing one. */
export const CollapsedRailAllView: Story = {
  name: "Collapsed rail · all view",
  beforeEach: () => seedViewMode("asst-collapsed-all", "all"),
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-collapsed-all",
    collapsed: true,
    footerAction: <PreferencesMenu assistantId="asst-story" />,
  },
};

/* What a cold load looks like before the conversation list resolves. The list
   is one query that settles only once every page of it is in, so on a busy
   assistant this state holds for seconds, and the placeholders are what keep
   it distinguishable from an assistant with no conversations at all. */
export const LoadingConversations: Story = {
  name: "Loading conversations",
  beforeEach: () => seedViewMode("asst-loading", "all"),
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-loading",
    conversations: [],
    isLoadingConversations: true,
  },
};

/**
 * The identity row wearing an uploaded image. One slot, and whichever avatar
 * the assistant has occupies it: this is the same slot the story below fills
 * with a character's eyes.
 *
 * The pill stays plain rather than tinted. A colour is read from a character's
 * palette and nothing derives one from an image.
 */
export const UploadedImageAvatar: Story = {
  name: "Identity row · uploaded image avatar",
  beforeEach: () => seedViewMode("asst-image", "all"),
  decorators: [withAvatar(IMAGE_AVATAR_CLIENT)],
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-image",
    assistantName: "Haze II",
  },
};

/** The same row on the collapsed rail, where the image fills the tile. */
export const UploadedImageAvatarCollapsed: Story = {
  name: "Identity row · uploaded image avatar, collapsed",
  beforeEach: () => seedViewMode("asst-image", "all"),
  decorators: [withAvatar(IMAGE_AVATAR_CLIENT)],
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-image",
    assistantName: "Haze II",
    collapsed: true,
    footerAction: <PreferencesMenu assistantId="asst-story" />,
  },
};

/**
 * The character-avatar treatment: the eyes in the leading slot, the pill
 * painted in the avatar's colour, and the name flipped for contrast against
 * it. The eyes blink where they sit.
 */
export const CharacterAvatar: Story = {
  name: "Identity row · character avatar",
  beforeEach: () => seedViewMode("asst-character", "all"),
  decorators: [withAvatar(CHARACTER_AVATAR_CLIENT)],
  args: {
    ...SHARED_ARGS,
    assistantId: "asst-character",
    assistantName: "Haze II",
  },
};

/**
 * The mobile drawer (Figma 7842-83305). Its own decorator, because the
 * overlay's shell is not the desktop one: `chat-layout` mounts it as a
 * full-bleed sheet over the chat, and the page behind it has to be there to
 * confirm the sheet's opaque surface fully covers it. The frame is a
 * 402x874 phone.
 */
export const OverlayDrawer: Story = {
  name: "Overlay drawer (mobile)",
  parameters: { layout: "centered" },
  beforeEach: () => seedViewMode("asst-overlay", "all"),
  decorators: [
    (Story) => (
      <div className="relative h-[874px] w-[402px] overflow-hidden bg-[var(--surface-base)]">
        {/* Stand-in for the chat the drawer covers: only whether the sheet
            fully hides it is under test, not its own layout. */}
        <div className="absolute inset-0 flex flex-col gap-3 p-4 pt-24 text-body-medium-lighter text-[var(--content-default)]">
          <p>You&rsquo;re absolutely right, and thank you for correcting me.</p>
          <p>
            The decel valve draws its air from above the sensor plate, so CIS
            has accounted for that air with a corresponding fuel increase.
          </p>
        </div>
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
    ...SHARED_ARGS,
    assistantId: "asst-overlay",
    conversations: LONG_CONVERSATIONS,
    variant: "overlay",
    collapsed: false,
    onClose: () => {},
    /* `chat-layout` switches the trigger for the overlay; the story does the
       same so the pill it shows is the one the drawer actually mounts. */
    footerAction: (
      <PreferencesMenu assistantId="asst-overlay" triggerVariant="pill" />
    ),
    notificationsAction: (
      <Button variant="ghost" iconOnly={<Bell />} aria-label="Notifications" />
    ),
  },
};
