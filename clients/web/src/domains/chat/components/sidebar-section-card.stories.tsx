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

import { cn } from "@vellumai/design-library";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { SIDEBAR_SECTION_TITLE_TEXT_CLASSES } from "@/components/sidebar-nav-geometry";
import { GroupIndicatorDot } from "@/domains/chat/components/collapsed-group-icon";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import {
  GroupActionsMenu,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import { SidebarSectionCard } from "@/domains/chat/components/sidebar-section-card";
import { SidebarViewModeSelect } from "@/domains/chat/components/sidebar-view-mode-select";
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
 * every story provides one. Drag-reorder is off, which is what a
 * non-reorderable section passes in the app.
 */
const LIST_CONTEXT = {
  activeConversationId: "c1",
  onSelect: () => {},
  canReorder: false,
  dragReorder: {
    draggingId: null,
    dropIndicator: null,
    getItemProps: () => ({}),
  },
} as unknown as React.ComponentProps<
  typeof ConversationListProvider
>["value"];

/**
 * A section's own actions, as the sidebar wires them. Deliberately the real
 * `GroupMenuItemsProps`, not a hand-written item list: `ConversationNavSection`
 * renders these into the header's right-click menu and, on touch, its
 * long-press sheet, and `GroupActionsMenu` renders the same set behind the
 * hover "…". Faking the items here would document a menu the app never shows.
 *
 * These are section actions. A row's actions (pin, archive, move to group,
 * inspect) live on `ConversationRow` and are a different set entirely.
 */
const GROUP_MENU: GroupMenuItemsProps = {
  onMarkAllRead: () => {},
  hasUnreadConversations: true,
  onArchiveAll: () => {},
  hasConversations: true,
  onRename: () => {},
  onDelete: () => {},
  onCopyGroupId: () => {},
  onMoveDown: () => {},
};

/**
 * The Chats card additionally carries the view-mode toggle. It is a property
 * of the section rather than a bulk action, so it rides in the menu's footer
 * slot, which is where the deleted sidebar-wide "Conversations" header used
 * to keep it.
 */
const GROUP_BY_FOOTER = (
  <div className="px-2 pb-1">
    <div className={cn("mt-3 mb-2", SIDEBAR_SECTION_TITLE_TEXT_CLASSES)}>
      Group by
    </div>
    <SidebarViewModeSelect value="all" onChange={() => {}} />
  </div>
);

const meta = {
  title: "Chat/SidebarSectionCard",
  component: SidebarSectionCard,
  globals: {
    viewport: { value: "sbDesktop", isRotated: false },
  },
  parameters: {
    layout: "padded",
    viewport: {
      options: {
        sbDesktop: {
          name: "Desktop",
          styles: { width: "1280px", height: "760px" },
          type: "desktop",
        },
      },
    },
    /* Conversation rows and section headers carry `max-md:` variants for the
       mobile drawer (16px type at 36px tall instead of 14px at 30px). Those
       key off the *viewport*, so in a narrow Canvas iframe these stories
       would render the drawer's metrics inside the desktop rail, a
       combination the app never ships.

       It does not reach the Docs canvas: every story on a docs page shares
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
    groupMenu: GROUP_MENU,
    trailing: <GroupActionsMenu label="Pinned" {...GROUP_MENU} />,
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
    groupMenu: GROUP_MENU,
    trailing: <GroupActionsMenu label="Car Chat" {...GROUP_MENU} />,
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
 * The header's actions are the section's: mark all read, archive all,
 * rename, delete, reorder, plus the Group by toggle this card owns now that
 * the sidebar-wide "Conversations" header is gone. They are reachable from
 * the hover "…", from right-clicking the header, and from a long-press on
 * touch, all rendered from one `groupMenu`.
 *
 * A row's actions are its own (pin, archive, move to group, inspect) and
 * come from `ConversationRow`. Right-click a row here to see the difference.
 */
export const SectionMenuVersusRowMenu: Story = {
  args: {
    value: "chats",
    label: "Chats",
    items: CHATS.slice(0, 4),
    groupMenu: GROUP_MENU,
    trailing: (
      <GroupActionsMenu label="Chats" footer={GROUP_BY_FOOTER} {...GROUP_MENU} />
    ),
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
        groupMenu={GROUP_MENU}
        trailing={<GroupActionsMenu label="Pinned" {...GROUP_MENU} />}
      />
      <SidebarSectionCard
        value="car-chat"
        label="Car Chat"
        items={[]}
        collapsedIndicator={<GroupIndicatorDot state="unread" />}
        groupMenu={GROUP_MENU}
        trailing={<GroupActionsMenu label="Car Chat" {...GROUP_MENU} />}
      />
      <SidebarSectionCard
        value="chats"
        label="Chats"
        items={CHATS}
        groupMenu={GROUP_MENU}
        trailing={
          <GroupActionsMenu
            label="Chats"
            footer={GROUP_BY_FOOTER}
            {...GROUP_MENU}
          />
        }
      />
    </CollapsibleNavSection.Root>
  ),
};
