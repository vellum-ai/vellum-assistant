/**
 * All chats: the whole history on one page, banded by date.
 *
 * The page is presentational, so these stories render exactly what ships.
 * They mount the real {@link ConversationListProvider} rather than stand-in
 * callbacks, so right-clicking a row opens the sidebar's own menu and the
 * trailing check is the affordance the page really carries.
 *
 * The rows are seeded against a fixed `now`, so the band headings read the
 * same on every day the story is opened.
 *
 * The page ships behind `sidebar-done` and its route redirects with the flag
 * off, so every story turns the flag on for its run and puts it back after.
 */

import type { Meta, StoryObj, StoryContext } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useArgs } from "storybook/preview-api";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import { ChatsSettingsDialog } from "@/domains/chat/components/chats-settings-dialog";
import type { ChatsSettingsChanges } from "@/domains/chat/components/chats-settings-modal";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConfigGetResponse } from "@/generated/daemon/types.gen";
import { createStoryQueryClient } from "@/lib/story-query-cache";
import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import { AllChatsActivityBadge } from "@/domains/chat/components/all-chats-activity-badge";
import {
  AllChatsPage,
  type AllChatsPageProps,
} from "@/domains/chat/pages/all-chats-page";
import type { AllChatsFilter } from "@/domains/chat/utils/all-chats-filters";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { compareByRecency } from "@/utils/conversation-order";

/** The instant the bands are measured against, so the headings never move. */
const NOW = new Date(2026, 8, 18, 14, 30);

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number, hour = 11): number {
  const date = new Date(NOW.getTime() - days * DAY_MS);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

const GROUPS: ConversationGroup[] = [
  { id: "group-work", name: "Work", sortPosition: 0, isSystemGroup: false },
  { id: "group-house", name: "House", sortPosition: 1, isSystemGroup: false },
];

/* Synthetic titles at the widths a real history runs to. Nothing here is
   drawn from anyone's conversations. */
const TITLES = [
  "Release notes for the March cut",
  "Weekly meal plan",
  "Lease renewal questions",
  "Book recommendations for the flight",
  "Budget spreadsheet help",
  "Resume feedback",
  "Home gym setup",
  "Wedding toast draft",
  "Quarterly roadmap questions",
  "Bug triage walkthrough",
  "Design review notes",
  "A title long enough to run past the row and truncate on a narrow screen",
  "Retro action items",
  "Choosing a chart library",
  "Onboarding checklist review",
  "Weekend hike recommendations",
  "Sourdough starter troubleshooting",
  "Rename the staging environment",
];

/** Roughly one row per day back through a year, so every band is populated. */
const DAY_OFFSETS = [
  0, 0, 0, 1, 1, 2, 3, 5, 6, 8, 11, 14, 19, 24, 28, 33, 40, 47, 55, 62, 70, 84,
  95, 110, 125, 140, 160, 180, 200, 215, 230, 250, 275, 300, 320, 340, 355, 365,
  380, 400, 420, 445,
];

const CHANNELS = ["vellum", "slack", "telegram", "email"];

const DAILY_HISTORY: Conversation[] = DAY_OFFSETS.map((offset, index) => {
  const channel = CHANNELS[index % CHANNELS.length];
  return {
    conversationId: `conv-${index + 1}`,
    title: TITLES[index % TITLES.length],
    /* Kept before `NOW`'s 14:30 so today's rows read as times already past,
       which is what a real history holds. */
    lastMessageAt: daysAgo(offset, 8 + (index % 6)),
    createdAt: daysAgo(offset + 1),
    originChannel: channel,
    /* Every fifth row is filed as done, and every seventh belongs to a
       custom group, so both states appear above and below the fold. */
    ...(index % 5 === 2 ? { archivedAt: daysAgo(offset) } : {}),
    ...(index % 7 === 3 ? { groupId: "group-work" } : {}),
    ...(index % 11 === 5 ? { groupId: "group-house" } : {}),
  };
});

/* An old chat marked done this afternoon. Marking done is activity, so it
   leads Today rather than sitting in the month it was last written to. */
const HISTORY: Conversation[] = [
  ...DAILY_HISTORY,
  {
    conversationId: "conv-done-today",
    title: "Passport renewal checklist",
    lastMessageAt: daysAgo(40, 9),
    createdAt: daysAgo(41),
    originChannel: "vellum",
    archivedAt: daysAgo(0, 14),
  },
];

const BACKGROUND: Conversation[] = [
  {
    conversationId: "conv-run-1",
    title: "Morning heartbeat",
    conversationType: "background",
    lastMessageAt: daysAgo(0, 7),
  },
  {
    conversationId: "conv-run-2",
    title: "Inbox sweep",
    conversationType: "scheduled",
    lastMessageAt: daysAgo(1, 7),
  },
  {
    conversationId: "conv-run-3",
    title: "Memory consolidation",
    conversationType: "background",
    lastMessageAt: daysAgo(9, 3),
  },
];

/** In the order the daemon pages them. */
const CONVERSATIONS = [...HISTORY, ...BACKGROUND].sort(compareByRecency);

/**
 * The row callbacks, as the chat layout wires them. The real page hands the
 * sidebar's `useConversationActions` handlers through this same value, so a
 * story that faked the menu would document a menu the app never shows.
 */
const LIST_CONTEXT: AllChatsPageProps["listContext"] = {
  onSelect: () => {},
  onPin: () => {},
  onRename: () => {},
  onArchive: () => {},
  onUnarchive: () => {},
  onDelete: () => {},
  onMarkRead: () => {},
  conversationGroups: GROUPS,
  onMoveToGroup: () => {},
};

const SETTINGS_ASSISTANT_ID = "story-assistant";

function settingsFixture(
  context: StoryContext<AllChatsPageProps>,
): ConfigGetResponse {
  return {
    conversations: {
      autoArchive: {
        enabled: context.parameters.autoArchiveEnabled === true,
        afterDays: 7,
      },
    },
    notifications: {
      newMessageEnabled: context.parameters.notificationsOff !== true,
    },
  };
}

function withSidebarDoneFlag(context: StoryContext<AllChatsPageProps>) {
  const previous = useClientFeatureFlagStore.getState().sidebarDone;
  const previousAssistant =
    useResolvedAssistantsStore.getState().activeAssistantId;
  useClientFeatureFlagStore.setState({ sidebarDone: true });
  useResolvedAssistantsStore.setState({
    activeAssistantId: SETTINGS_ASSISTANT_ID,
  });
  let config = settingsFixture(context);
  const restoreFetch = stubClientFetch(daemonClient, async (request) => {
    if (!new URL(request.url).pathname.endsWith("/config")) {
      return fixtureNotFound();
    }
    if (request.method === "PATCH") {
      const changes = (await request.json()) as ChatsSettingsChanges;
      config = {
        conversations: {
          autoArchive: {
            ...config.conversations!.autoArchive,
            ...changes?.conversations?.autoArchive,
          },
        },
        notifications: { ...config.notifications!, ...changes?.notifications },
      };
    }
    return Response.json(config);
  });
  return () => {
    restoreFetch();
    useResolvedAssistantsStore.setState({
      activeAssistantId: previousAssistant,
    });
    useClientFeatureFlagStore.setState({ sidebarDone: previous });
  };
}

function SettingsPageStory({
  args,
  initiallyOpen,
}: {
  args: AllChatsPageProps;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex h-screen flex-col p-4 max-md:p-0">
      <AllChatsPage
        {...args}
        onOpenSettings={() => setOpen(true)}
        settingsButtonRef={buttonRef}
      />
      {open && (
        <ChatsSettingsDialog
          assistantId={SETTINGS_ASSISTANT_ID}
          onClose={() => setOpen(false)}
          returnFocusRef={buttonRef}
        />
      )}
    </div>
  );
}

const meta = {
  title: "Chat/All Chats Page",
  component: AllChatsPage,
  parameters: { layout: "fullscreen" },
  tags: ["!autodocs"],
  beforeEach: withSidebarDoneFlag,
  args: {
    conversations: CONVERSATIONS,
    groups: GROUPS,
    filter: { kind: "all" } satisfies AllChatsFilter,
    /* Replaced by `render` with the args-writing handler below; declared here
       because the prop is required and the meta owns every default. */
    onFilterChange: () => {},
    listContext: LIST_CONTEXT,
    hasMore: false,
    onLoadMore: () => {},
    isLoading: false,
    isError: false,
    onRetry: () => {},
    onClose: () => {},
    now: NOW,
  },
  argTypes: {
    conversations: { control: false },
    groups: { control: false },
    listContext: { control: false },
    filter: { control: false },
    renderActivity: { control: false },
    onRowMount: { control: false },
  },
  /* The chip row is a controlled selection, so the story writes the choice
     back into its own args and the canvas stays live (design-library story
     rule 3). */
  render: function Render(args, context) {
    const [{ filter }, updateArgs] = useArgs<AllChatsPageProps>();
    const [queryClient] = useState(() =>
      createStoryQueryClient((cache) => {
        cache.setQueryData(
          ["assistant-capability", "chatsSettings", SETTINGS_ASSISTANT_ID],
          true,
        );
        cache.setQueryData(
          configGetQueryKey({ path: { assistant_id: SETTINGS_ASSISTANT_ID } }),
          settingsFixture(context),
        );
      }),
    );
    return (
      <QueryClientProvider client={queryClient}>
        <SettingsPageStory
          args={{
            ...args,
            filter,
            onFilterChange: (next) => updateArgs({ filter: next }),
          }}
          initiallyOpen={context.parameters.settingsOpen === true}
        />
      </QueryClientProvider>
    );
  },
  decorators: [
    (Story) => (
      <ConversationListProvider value={LIST_CONTEXT}>
        <Story />
      </ConversationListProvider>
    ),
  ],
} satisfies Meta<typeof AllChatsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The page as it opens: every band from Today down through the months, with
 * the automated rows held back. Hover a row to trade its timestamp for the
 * Done check; right-click one for Rename, Move to group and Delete.
 */
export const Default: Story = {};

export const SettingsOpen: Story = {
  parameters: { settingsOpen: true },
};

export const SettingsMobile: Story = {
  parameters: { settingsOpen: true },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

export const SettingsPreferences: Story = {
  parameters: {
    settingsOpen: true,
    autoArchiveEnabled: true,
    notificationsOff: true,
  },
};

export const SettingsSaveFlow: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole("button", { name: "Chats Settings" }));
    const dialog = await page.findByRole("dialog", { name: "Chats Settings" });
    await userEvent.click(
      await within(dialog).findByRole("switch", {
        name: "Chat reply alerts",
      }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Confirm" }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await userEvent.click(page.getByRole("button", { name: "Chats Settings" }));
    const reopenedDialog = await page.findByRole("dialog", {
      name: "Chats Settings",
    });
    await expect(
      await within(reopenedDialog).findByRole("switch", {
        name: "Chat reply alerts",
      }),
    ).toHaveAttribute("aria-checked", "false");
  },
};

/**
 * One channel preselected, which is what a sidebar section header's link
 * lands on (`?channel=slack`). The chip row is unchanged; only the selection
 * and the rows below it move.
 */
export const FilteredByChannel: Story = {
  args: { filter: { kind: "channel", channelId: "slack" } },
};

/** The Done view (`?filter=done`): the chats already filed away. */
export const DoneOnly: Story = {
  args: { filter: { kind: "done" } },
};

/**
 * Background (`?filter=background`): the heartbeat, the scheduled runs and
 * the assistant's own housekeeping, which every other view hides.
 */
export const WithBackground: Story = {
  args: { filter: { kind: "background" } },
};

/** A history with nothing in it yet. */
export const Empty: Story = {
  args: { conversations: [], groups: [] },
};

/**
 * A view with no match in the loaded window while the server still holds
 * older pages. The chips and the search run over what is loaded, so this
 * keeps paging rather than claiming the view is empty.
 */
export const SearchingOlderPages: Story = {
  args: { conversations: [], hasMore: true },
};

/** The first read still out. */
export const Loading: Story = {
  args: { isLoading: true },
};

/** The read failed before it ever landed, so the page offers the retry. */
export const LoadFailed: Story = {
  args: { isError: true },
};

/**
 * Phone width. The row's title has less room, the chip row scrolls sideways
 * rather than wrapping, and a visible menu reaches every action on touch.
 */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** Unread, Done, and task status share the row without hiding one another. */
export const WithActivity: Story = {
  args: {
    conversations: HISTORY.slice(0, 12).map((conversation, index) => ({
      ...conversation,
      hasUnseenLatestAssistantMessage: index % 3 === 0,
    })),
    renderActivity: (conversation) => {
      if (conversation.conversationId === "conv-2") {
        return (
          <AllChatsActivityBadge status="running" count={2}>
            <span className="inline-flex">
              <SubagentAvatarChip subagentId="agent-review" />
              <SubagentAvatarChip subagentId="agent-research" />
            </span>
          </AllChatsActivityBadge>
        );
      }
      if (conversation.conversationId === "conv-4") {
        return <AllChatsActivityBadge status="attention" count={1} />;
      }
      if (
        conversation.conversationId === "conv-5" ||
        conversation.conversationId === "conv-12"
      ) {
        return <AllChatsActivityBadge status="running" count={1} />;
      }
      return null;
    },
  },
};

export const MobileWithActivity: Story = {
  args: WithActivity.args,
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
