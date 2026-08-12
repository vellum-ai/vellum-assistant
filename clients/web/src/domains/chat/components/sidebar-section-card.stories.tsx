/**
 * Visual reference for the sidebar's section card.
 *
 * Every sidebar section is this card: Pinned, each custom group, each
 * channel, and the chat list. The card is only the surface; the header,
 * collapse, indicator, and menus come from `CollapsibleNavSection.Section`,
 * so these stories mount the real section machinery and the real
 * {@link ConversationRow} rather than stand-in markup.
 *
 * Sections share one `CollapsibleNavSection.Root`, which is how the sidebar
 * mounts them, so `defaultValue` decides which cards start open.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { GroupIndicatorDot } from "@/domains/chat/components/collapsed-group-icon";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import {
  GroupActionsMenu,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import { SidebarSectionCard } from "@/domains/chat/components/sidebar-section-card";
import type { Conversation } from "@/types/conversation-types";

function conversation(
  conversationId: string,
  title: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return { conversationId, title, ...overrides };
}

const PINNED: Conversation[] = [
  conversation("p1", "Fernweh Coffee landing page", { isPinned: true }),
  conversation("p2", "Weekend hike recommendations for the coast", {
    isPinned: true,
  }),
];

const CHATS: Conversation[] = [
  conversation("c1", "Various topics"),
  conversation("c2", "Lease renewal"),
  conversation("c3", "Resume feedback"),
  conversation("c4", "Weekly meal plan", {
    hasUnseenLatestAssistantMessage: true,
  }),
  conversation("c5", "Home gym setup"),
  conversation("c6", "Wedding toast draft"),
  conversation("c7", "Budget spreadsheet help"),
  conversation("c8", "Book recommendations"),
];

/**
 * Rows read their callbacks and active/processing state from context, so
 * every story provides one.
 */
const LIST_CONTEXT: React.ComponentProps<
  typeof ConversationListProvider
>["value"] = {
  activeConversationId: "c1",
  onSelect: () => {},
};

/**
 * A section's own actions, as the sidebar wires them. Deliberately the real
 * `GroupMenuItemsProps`, not a hand-written item list: `ConversationNavSection`
 * renders these into the header's right-click menu and, on touch, its
 * long-press sheet, and `GroupActionsMenu` renders the same set behind the
 * hover "…". Faking the items here would document a menu the app never shows.
 *
 * These are section actions. A row's actions (pin, archive, move to group,
 * inspect) live on `ConversationRow` and are a different set entirely.
 *
 * Three shapes, because the sidebar wires three (`sectionMenu` in
 * `assistant-side-menu.tsx`). Every section gets the bulk actions and the
 * reorder nudges; what varies is the one thing a section owns on top of them,
 * and no section owns two. One fixture shared across all three is how this file
 * came to offer Chats a Rename it cannot have.
 */
const BULK_AND_REORDER: GroupMenuItemsProps = {
  onMarkAllRead: () => {},
  hasUnreadConversations: true,
  onArchiveAll: () => {},
  hasConversations: true,
  onMoveDown: () => {},
};

/** Pinned owns nothing extra: it is never renamed, and the switch skips it. */
const PINNED_MENU: GroupMenuItemsProps = BULK_AND_REORDER;

/** A custom group is the only section a user may rename or delete. */
const CUSTOM_GROUP_MENU: GroupMenuItemsProps = {
  ...BULK_AND_REORDER,
  onRename: () => {},
  onDelete: () => {},
  onCopyGroupId: () => {},
};

/**
 * Chats and the channel sections carry the channel-grouping toggle, since they
 * are what the switch reshapes. An item in the menu, labelled for the view it
 * leaves for ("Group by channel" here, "Ungroup" once grouped) - this is where
 * the deleted sidebar-wide "Conversations" header's dropdown went, and it is a
 * menu item now rather than a Select in a footer slot.
 */
const CHATS_MENU: GroupMenuItemsProps = {
  ...BULK_AND_REORDER,
  onToggleGroupByChannel: () => {},
  isGroupedByChannel: false,
};

const meta = {
  title: "Chat/SidebarSectionCard",
  component: SidebarSectionCard,
  parameters: {
    layout: "padded",
    /* Conversation rows and section headers carry `max-md:` variants for the
       mobile drawer (16px type at 36px tall instead of 14px at 30px). Those
       key off the *viewport*, and the desktop width every story starts at
       (see `.storybook/preview.tsx`) keeps the Canvas above the `md`
       breakpoint, so the rail is never reviewed with the drawer's metrics.

       That does not reach the Docs canvas: every story on a docs page shares
       one iframe. Read these in Canvas. Tracked in LUM-2921. */
  },
  decorators: [
    (Story) => (
      <ConversationListProvider value={LIST_CONTEXT}>
        {/* The rail's real width, so title truncation reads truthfully. */}
        <div style={{ width: 248 }}>
          <Story />
        </div>
      </ConversationListProvider>
    ),
  ],
} satisfies Meta<typeof SidebarSectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Pinned carries the hover "…" and grows to fit its rows rather than
 * capping and scrolling within itself, as it does in the sidebar today.
 */
export const Pinned: Story = {
  args: {
    value: "pinned",
    label: "Pinned",
    items: PINNED,
    unbounded: true,
    groupMenu: PINNED_MENU,
    trailing: <GroupActionsMenu label="Pinned" {...PINNED_MENU} />,
  },
  render: (args) => (
    <CollapsibleNavSection.Root type="multiple" defaultValue={["pinned"]}>
      <SidebarSectionCard {...args} />
    </CollapsibleNavSection.Root>
  ),
};

/**
 * A custom group, collapsed, carrying its unread dot in the header.
 *
 * No leading icon: `CollapsibleNavSection.Section` renders `icon` only in its
 * non-collapsible branch, so a collapsible section drops it. The design gives
 * custom groups a folder glyph, which means the shared section component needs
 * to render icons on collapsible headers before these cards can show one. That
 * is a change to a component the current sidebar renders through, so it is
 * tracked separately rather than folded into this presentational slice.
 */
export const CollapsedGroup: Story = {
  args: {
    value: "car-chat",
    label: "Car Chat",
    items: [],
    collapsedIndicator: <GroupIndicatorDot state="unread" />,
    groupMenu: CUSTOM_GROUP_MENU,
    trailing: <GroupActionsMenu label="Car Chat" {...CUSTOM_GROUP_MENU} />,
  },
  render: (args) => (
    <CollapsibleNavSection.Root type="multiple" defaultValue={[]}>
      <SidebarSectionCard {...args} />
    </CollapsibleNavSection.Root>
  ),
};

/** Expanded, the header dot gives way to the row's own indicator. */
export const Chats: Story = {
  args: {
    value: "chats",
    label: "Chats",
    items: CHATS,
    collapsedIndicator: <GroupIndicatorDot state="unread" />,
  },
  render: (args) => (
    <CollapsibleNavSection.Root type="multiple" defaultValue={["chats"]}>
      <SidebarSectionCard {...args} />
    </CollapsibleNavSection.Root>
  ),
};

/**
 * The two menus, which are not the same menu.
 *
 * The header's actions are the section's. This is the Chats card, so: mark all
 * read, archive all, reorder, plus the channel-grouping toggle it owns now that
 * the sidebar-wide "Conversations" header is gone. No rename or delete - those
 * belong to a custom group, and the Chats list is not one (see `CollapsedGroup`
 * for the menu that has them). They are reachable from the hover "…", from
 * right-clicking the header, and from a long-press on touch, all rendered from
 * one `groupMenu`.
 *
 * A row's actions are its own (pin, archive, move to group, inspect) and
 * come from `ConversationRow`. Right-click a row here to see the difference.
 */
export const SectionMenuVersusRowMenu: Story = {
  args: {
    value: "chats",
    label: "Chats",
    items: CHATS.slice(0, 4),
    groupMenu: CHATS_MENU,
    trailing: <GroupActionsMenu label="Chats" {...CHATS_MENU} />,
  },
  render: (args) => (
    <CollapsibleNavSection.Root type="multiple" defaultValue={["chats"]}>
      <SidebarSectionCard {...args} />
    </CollapsibleNavSection.Root>
  ),
};

/** The sidebar's stack: curated cards above, the chat list below. */
export const Composed: Story = {
  args: { value: "pinned", label: "Pinned", items: PINNED },
  render: () => (
    <CollapsibleNavSection.Root
      type="multiple"
      defaultValue={["pinned", "chats"]}
    >
      <SidebarSectionCard
        value="pinned"
        label="Pinned"
        items={PINNED}
        unbounded
        groupMenu={PINNED_MENU}
        trailing={<GroupActionsMenu label="Pinned" {...PINNED_MENU} />}
      />
      <SidebarSectionCard
        value="car-chat"
        label="Car Chat"
        items={[]}
        collapsedIndicator={<GroupIndicatorDot state="unread" />}
        groupMenu={CUSTOM_GROUP_MENU}
        trailing={<GroupActionsMenu label="Car Chat" {...CUSTOM_GROUP_MENU} />}
      />
      <SidebarSectionCard
        value="chats"
        label="Chats"
        items={CHATS}
        groupMenu={CHATS_MENU}
        trailing={<GroupActionsMenu label="Chats" {...CHATS_MENU} />}
      />
    </CollapsibleNavSection.Root>
  ),
};
