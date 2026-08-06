/**
 * The assistant sidebar, assembled.
 *
 * This is the review surface for the whole nav: pills, cards, and the
 * collapsed rail in one place, rendered by the components that ship rather
 * than arranged by the story. Everything here is a real component, so a
 * regression in any of them shows up here.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Folder,
  LayoutGrid,
  MessageSquare,
  Pin,
  Plus,
  Settings,
} from "lucide-react";

import {
  AssistantSidebar,
  type AssistantSidebarPill,
  type AssistantSidebarSection,
} from "@/domains/chat/components/assistant-sidebar";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import {
  GroupActionsMenu,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import type { Conversation } from "@/types/conversation-types";

/** Stand-in for the assistant's trait color, which varies per assistant. */
const ASSISTANT_TINT = "#2FA37C";

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

const CAR_CHAT: Conversation[] = [
  conversation("g1", "Squeaky brakes"),
  conversation("g2", "Lease renewal"),
];

const CHATS: Conversation[] = [
  conversation("c1", "Various topics"),
  conversation("c2", "Resume feedback"),
  conversation("c3", "Weekly meal plan", {
    hasUnseenLatestAssistantMessage: true,
  }),
  conversation("c4", "Home gym setup"),
  conversation("c5", "Wedding toast draft"),
  conversation("c6", "Budget spreadsheet help"),
  conversation("c7", "Book recommendations"),
  conversation("c8", "Moving checklist"),
];

const GROUP_MENU: GroupMenuItemsProps = {
  onMarkAllRead: () => {},
  hasUnreadConversations: true,
  onArchiveAll: () => {},
  hasConversations: true,
  onRename: () => {},
  onDelete: () => {},
  onCopyGroupId: () => {},
};

const SECTIONS: AssistantSidebarSection[] = [
  {
    key: "pinned",
    label: "Pinned",
    icon: Pin,
    items: PINNED,
    unbounded: true,
    groupMenu: GROUP_MENU,
    trailing: <GroupActionsMenu label="Pinned" {...GROUP_MENU} />,
  },
  {
    key: "car-chat",
    label: "Car Chat",
    icon: Folder,
    items: CAR_CHAT,
    indicatorState: "unread",
    groupMenu: GROUP_MENU,
    trailing: <GroupActionsMenu label="Car Chat" {...GROUP_MENU} />,
  },
  {
    key: "chats",
    label: "Chats",
    icon: MessageSquare,
    items: CHATS,
    indicatorState: "unread",
    groupMenu: GROUP_MENU,
    trailing: <GroupActionsMenu label="Chats" {...GROUP_MENU} />,
  },
];

/**
 * The nav above the sections. Each is the shipped `PanelItem` at pill shape;
 * the assistant's wears its own trait color, which the app resolves per
 * assistant and the hex here only stands in for.
 */
const PILLS: AssistantSidebarPill[] = [
  {
    key: "assistant",
    label: "Example Assistant",
    tint: ASSISTANT_TINT,
    leadingSlot: (
      <span
        aria-hidden
        className="size-6 shrink-0 rounded-full"
        style={{ background: ASSISTANT_TINT }}
      />
    ),
    onSelect: () => {},
  },
  { key: "memory", label: "Memory", icon: LayoutGrid, onSelect: () => {} },
  { key: "new-chat", label: "New Chat", icon: Plus, onSelect: () => {} },
];

const FOOTER: AssistantSidebarPill[] = [
  {
    key: "preferences",
    label: "Preferences",
    icon: Settings,
    onSelect: () => {},
  },
];

/** Rows read their state from context; drag-reorder is off, as in a
 *  non-reorderable section. */
const LIST_CONTEXT = {
  activeConversationId: "c1",
  onSelect: () => {},
  canReorder: false,
  dragReorder: {
    draggingId: null,
    dropIndicator: null,
    getItemProps: () => ({}),
  },
} as unknown as React.ComponentProps<typeof ConversationListProvider>["value"];

const meta = {
  title: "Chat/AssistantSidebar",
  component: AssistantSidebar,
  args: {
    sections: SECTIONS,
    pills: PILLS,
    footer: FOOTER,
    openSections: ["pinned", "chats"],
  },
  argTypes: {
    collapsed: { control: "boolean" },
    variant: { control: "inline-radio", options: ["rail", "overlay"] },
    sections: { control: false },
    pills: { control: false },
    footer: { control: false },
    openSections: { control: false },
    onOpenSectionsChange: { control: false },
    onWidthChange: { control: false },
  },
  globals: { viewport: { value: "sbDesktop", isRotated: false } },
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        sbDesktop: {
          name: "Desktop",
          styles: { width: "1280px", height: "760px" },
          type: "desktop",
        },
      },
    },
    /* Rows and headers carry `max-md:` variants for the mobile drawer, which
       key off the *viewport*. Without a pinned viewport the narrow Canvas
       iframe documents the drawer's metrics inside the desktop rail, a
       combination the app never ships. Read these in Canvas. */
  },
  decorators: [
    (Story) => (
      <ConversationListProvider value={LIST_CONTEXT}>
        <div className="h-[720px] bg-[var(--surface-base)] p-4">
          <Story />
        </div>
      </ConversationListProvider>
    ),
  ],
} satisfies Meta<typeof AssistantSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole sidebar: pills, three cards, Preferences at the bottom. */
export const Expanded: Story = {};

/** Collapsed: every pill and every section becomes a circle. */
export const Collapsed: Story = {
  args: { collapsed: true },
};

/** A card the user has closed keeps its unread indicator in the header. */
export const SectionCollapsed: Story = {
  args: { openSections: ["pinned"] },
};
