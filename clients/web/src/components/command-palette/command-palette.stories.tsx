/**
 * Visual reference for `CommandPalette`.
 *
 * The palette answers two different platform-adaptation questions at once, and
 * the stories exist to keep them visibly separate:
 *
 * - **Window size** decides the container: a centred overlay where a 560px
 *   panel fits, a full-screen sheet where it does not. Switch the Canvas
 *   viewport between Desktop and Mobile to see both.
 * - **Input capability** decides whether the keyboard hints render at all:
 *   the `⌘K` cap in the search row and the per-item shortcut hints. There is
 *   no soft keyboard that can produce those chords, so a coarse pointer drops
 *   them. Storybook cannot fake `(pointer: coarse)`, so read this one in a
 *   browser with touch emulation on, or in the shipped app on a device.
 *
 * The two come apart on real hardware, which is the whole reason they are two
 * signals: a tablet is roomy with a thumb, and a narrowed desktop window is
 * compact with a keyboard. See `docs/PLATFORM_ADAPTATION.md`.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Calendar,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Settings,
  SquarePen,
} from "lucide-react";
import { useState } from "react";

import { CommandPalette, type CommandPaletteSection } from "./command-palette";

/**
 * The sections the app really builds: a static Actions list carrying shortcut
 * hints (`buildActionsSection`) plus search results that carry none.
 */
const SECTIONS: CommandPaletteSection[] = [
  {
    id: "actions",
    label: "Actions",
    items: [
      {
        id: "action-new-conversation",
        icon: SquarePen,
        title: "New Conversation",
        shortcutHint: "⌘⇧O",
      },
      {
        id: "action-current-conversation",
        icon: Monitor,
        title: "Current Conversation",
        shortcutHint: "⌘⇧N",
      },
      {
        id: "action-settings",
        icon: Settings,
        title: "Settings",
        shortcutHint: "⌘,",
      },
      { id: "action-library", icon: LayoutGrid, title: "Library" },
    ],
  },
  {
    id: "conversations",
    label: "Conversations",
    items: [
      {
        id: "conv-1",
        icon: MessageSquare,
        title: "Quarterly planning notes",
        snippet: "…pull the revenue numbers before Thursday's review…",
      },
      {
        id: "conv-2",
        icon: MessageSquare,
        title: "Trip to Lisbon",
        subtitle: "3 days ago",
      },
      { id: "sched-1", icon: Calendar, title: "Morning brief" },
    ],
  },
];

/**
 * The palette is fully controlled, so a story that passed a frozen `query`
 * would render a search field nothing can type into. This owns the query and
 * the selection the way `useCommandPalette` does in the app.
 */
const ITEM_COUNT = SECTIONS.reduce((n, s) => n + s.items.length, 0);

function ControlledPalette({ surface }: { surface?: "overlay" | "window" }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  return (
    <CommandPalette
      isOpen
      onClose={() => {}}
      query={query}
      onQueryChange={setQuery}
      selectedIndex={selectedIndex}
      sections={SECTIONS}
      onItemSelect={() => {}}
      surface={surface}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, ITEM_COUNT - 1));
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
        }
      }}
    />
  );
}

const meta: Meta<typeof CommandPalette> = {
  title: "Components/CommandPalette",
  component: CommandPalette,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof CommandPalette>;

/**
 * The palette as the app opens it. On a roomy window this is a centred panel
 * over a backdrop; switch the Canvas viewport to Mobile and the same story
 * becomes the full-screen sheet, because the container is the window-size
 * question.
 */
export const Default: Story = {
  render: () => <ControlledPalette />,
};

/**
 * The Electron search window, which is its own window rather than an overlay:
 * no backdrop, no portal, and no sheet at any width: the window is already
 * sized to the palette.
 */
export const WindowSurface: Story = {
  render: () => (
    <div className="h-full w-full bg-[var(--surface-base)]">
      <ControlledPalette surface="window" />
    </div>
  ),
};
