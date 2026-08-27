/** Pure helper functions for command palette section building.
 *
 *  Separated from the React hook (`useCommandPaletteSections`) so they
 *  can be unit-tested without a component render cycle. */

import {
  Calendar,
  Contact,
  Globe,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Settings,
  SquarePen,
} from "lucide-react";

import { formatAcceleratorHint } from "@vellumai/design-library";

import type { CommandPaletteSection } from "@/components/command-palette/command-palette";
import type { GlobalSearchResponse } from "@/domains/chat/api/global-search";
import { newChatShortcutHint } from "@/domains/chat/new-chat-shortcut";

/** Build the static "Actions" section with keyboard shortcuts. */
export function buildActionsSection(
  assistantName: string,
): CommandPaletteSection {
  return {
    id: "actions",
    label: "Actions",
    items: [
      {
        id: "action-new-conversation",
        icon: SquarePen,
        title: "New Conversation",
        shortcutHint: newChatShortcutHint(),
      },
      {
        id: "action-current-conversation",
        icon: Monitor,
        title: "Current Conversation",
        shortcutHint: formatAcceleratorHint("CmdOrCtrl+Shift+N"),
      },
      {
        id: "action-settings",
        icon: Settings,
        title: "Settings",
        shortcutHint: formatAcceleratorHint("CmdOrCtrl+,"),
      },
      { id: "action-library", icon: LayoutGrid, title: "Library" },
      { id: "action-intelligence", icon: Globe, title: assistantName },
    ],
  };
}

/**
 * Build sections from server search results, deduplicating conversations
 * that already appear in the local recents section.
 */
export function buildServerResultSections(
  results: GlobalSearchResponse,
  recentConversationIds: Set<string>,
): CommandPaletteSection[] {
  const sections: CommandPaletteSection[] = [];

  const serverConvItems = results.conversations
    .filter((c) => !recentConversationIds.has(c.id))
    .map((c) => ({
      id: `search-conv-${c.id}`,
      icon: MessageSquare,
      title: c.title ?? "Untitled",
      snippet: c.excerpt || undefined,
    }));
  if (serverConvItems.length > 0) {
    sections.push({
      id: "search-conversations",
      label: "Conversations",
      items: serverConvItems,
    });
  }

  const scheduleItems = results.schedules.map((s) => ({
    id: `search-schedule-${s.id}`,
    icon: Calendar,
    title: s.name,
    subtitle: s.expression ?? s.message,
  }));
  if (scheduleItems.length > 0) {
    sections.push({
      id: "search-schedules",
      label: "Schedules",
      items: scheduleItems,
    });
  }

  const contactItems = results.contacts.map((c) => ({
    id: `search-contact-${c.id}`,
    icon: Contact,
    title: c.displayName,
    subtitle: c.notes ?? undefined,
  }));
  if (contactItems.length > 0) {
    sections.push({
      id: "search-contacts",
      label: "Contacts",
      items: contactItems,
    });
  }

  return sections;
}
