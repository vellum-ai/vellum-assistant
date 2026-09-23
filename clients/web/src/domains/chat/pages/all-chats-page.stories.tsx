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

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
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

const HISTORY: Conversation[] = DAY_OFFSETS.map((offset, index) => {
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

const CONVERSATIONS = [...HISTORY, ...BACKGROUND].sort(
  (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
);

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

/** Turns the flag on for the story's run and puts the old value back. */
function withSidebarDoneFlag() {
  const previous = useClientFeatureFlagStore.getState().sidebarDone;
  useClientFeatureFlagStore.setState({ sidebarDone: true });
  return () => {
    useClientFeatureFlagStore.setState({ sidebarDone: previous });
  };
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
    now: NOW,
  },
  argTypes: {
    conversations: { control: false },
    groups: { control: false },
    listContext: { control: false },
    filter: { control: false },
  },
  /* The chip row is a controlled selection, so the story writes the choice
     back into its own args and the canvas stays live (design-library story
     rule 3). */
  render: function Render(args) {
    const [{ filter }, updateArgs] = useArgs<AllChatsPageProps>();
    return (
      <div className="flex h-screen flex-col p-4">
        <AllChatsPage
          {...args}
          filter={filter}
          onFilterChange={(next) => updateArgs({ filter: next })}
        />
      </div>
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
 * rather than wrapping, and the check is present outright because the device
 * cannot hover.
 */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
