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
import { Folder } from "lucide-react";

import { ContextMenu } from "@vellumai/design-library";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import { GroupIndicatorDot } from "@/domains/chat/components/collapsed-group-icon";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import { ConversationRow } from "@/domains/chat/components/conversation-row";
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

function rows(items: Conversation[]) {
  return items.map((c) => (
    <ConversationRow key={c.conversationId} conversation={c} />
  ));
}

const SECTION_MENU = (
  <>
    <ContextMenu.Item>Mark all as read</ContextMenu.Item>
    <ContextMenu.Item>Archive all</ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Label>Group by</ContextMenu.Label>
    <ContextMenu.Item>None</ContextMenu.Item>
    <ContextMenu.Item>Channel</ContextMenu.Item>
  </>
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

export const Pinned: Story = {
  args: { value: "pinned", label: "Pinned" },
  render: (args) => (
    <CollapsibleNavSection.Root type="multiple" defaultValue={["pinned"]}>
      <SidebarSectionCard {...args}>{rows(PINNED)}</SidebarSectionCard>
    </CollapsibleNavSection.Root>
  ),
};

/** A custom group, collapsed, carrying its unread dot in the header. */
export const CollapsedGroup: Story = {
  args: {
    value: "car-chat",
    label: "Car Chat",
    icon: Folder,
    collapsedIndicator: <GroupIndicatorDot state="unread" />,
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
    collapsedIndicator: <GroupIndicatorDot state="unread" />,
  },
  render: (args) => (
    <CollapsibleNavSection.Root type="multiple" defaultValue={["chats"]}>
      <SidebarSectionCard {...args}>{rows(CHATS)}</SidebarSectionCard>
    </CollapsibleNavSection.Root>
  ),
};

/**
 * Right-click anywhere on the header opens the section's own menu, so
 * "Archive all" reaches this section's rows and no others.
 */
export const WithSectionMenu: Story = {
  args: {
    value: "chats",
    label: "Chats",
    contextMenuContent: SECTION_MENU,
    touchMenuContent: () => SECTION_MENU,
  },
  render: (args) => (
    <CollapsibleNavSection.Root type="multiple" defaultValue={["chats"]}>
      <SidebarSectionCard {...args}>{rows(CHATS.slice(0, 3))}</SidebarSectionCard>
    </CollapsibleNavSection.Root>
  ),
};

/** The sidebar's stack: curated cards above, the chat list below. */
export const Composed: Story = {
  args: { value: "pinned", label: "Pinned" },
  render: () => (
    <CollapsibleNavSection.Root
      type="multiple"
      defaultValue={["pinned", "chats"]}
    >
      <SidebarSectionCard value="pinned" label="Pinned">
        {rows(PINNED)}
      </SidebarSectionCard>
      <SidebarSectionCard
        value="car-chat"
        label="Car Chat"
        icon={Folder}
        collapsedIndicator={<GroupIndicatorDot state="unread" />}
      />
      <SidebarSectionCard value="chats" label="Chats">
        {rows(CHATS)}
      </SidebarSectionCard>
    </CollapsibleNavSection.Root>
  ),
};
