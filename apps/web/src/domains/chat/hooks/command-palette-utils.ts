/** Pure helper functions for command palette section building.
 *
 *  Separated from the React hook (`useCommandPaletteSections`) so they
 *  can be unit-tested without a component render cycle. */

import { Calendar, Contact, MessageSquare } from "lucide-react";

import type { CommandPaletteSection } from "@/components/command-palette/command-palette";
import type { GlobalSearchResponse } from "@/domains/chat/api/global-search";

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
      subtitle: c.excerpt,
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
