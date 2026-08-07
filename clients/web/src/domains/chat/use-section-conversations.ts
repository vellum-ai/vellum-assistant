/**
 * One sidebar section's conversations, fetched for that section alone.
 *
 * Every section that can name a server filter mounts this where it renders,
 * rather than a parent mounting one query and slicing the result. That is the
 * whole point of the arc: a section derived by filtering another section's
 * data can only be correct once that other list is *complete*, which is what
 * made a windowed conversation list impossible (LUM-2443).
 *
 * Two components mount this per section - the expanded card and the collapsed
 * rail icon. They share a query key, so TanStack serves both from one cache
 * entry and one request; this is deduplication, not a second fetch.
 *
 * Sections whose filter is not wired yet (Chats, the channel sections) return
 * the rows they were handed, unchanged, so this hook can be the single call
 * site while the sections migrate one at a time.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/query-keys}
 */

import { useMemo } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useSectionConversationListQuery } from "@/hooks/conversation-queries";
import { useSupportsGroupFilter } from "@/lib/backwards-compat/use-supports-group-filter";
import type { Conversation } from "@/types/conversation-types";
import {
  SYSTEM_PINNED_GROUP_ID,
  type SectionConversationFilter,
} from "@/utils/conversation-list-fetchers";

/**
 * Stable placeholder for a section with no filter of its own. The query is
 * disabled in that case, so this is never sent; it exists only because the
 * query hook takes a filter unconditionally.
 */
const NO_FILTER: SectionConversationFilter = {};

/**
 * What this section asks the server for, or `null` when it has no filter yet.
 *
 * Pinned and the custom groups are both answered by `groupId` alone, because
 * pinning is stored as group membership. A channel additionally needs
 * `originChannel`, which is why the filter is an object rather than an id -
 * but channels also need a way to know *which* sections exist before they can
 * be wired at all, so they stay on the derived rows for now.
 */
function sectionFilter(
  section: SidebarSection,
): SectionConversationFilter | null {
  switch (section.type) {
    case "pinned":
      return { groupId: SYSTEM_PINNED_GROUP_ID };
    case "group":
      return { groupId: section.group.id };
    case "recents":
    case "channel":
      return null;
  }
}

/**
 * The conversations to render for `section`.
 *
 * Falls back to the derived rows in three cases, all of which have to paint
 * something rather than an empty section:
 *
 * 1. **The section has no filter yet** (Chats, channels).
 * 2. **The gate is closed.** An assistant that predates the `groupId` filter
 *    ignores the unrecognized parameter and answers 200 with the *entire*
 *    conversation list, which would render in full inside one section. The
 *    gate is assistant-scoped, so a version still held for the outgoing
 *    assistant cannot authorize a filtered fetch against the incoming one.
 * 3. **The query has not answered once yet.** `conversations` is empty while
 *    pending, and an empty section is dropped from the sidebar entirely, so
 *    switching on the gate alone would make the section vanish on every cold
 *    load until a multi-page drain finished. The derived rows are a subset
 *    (whatever the foreground page happened to contain), so the section
 *    paints immediately and fills in. `isPending` is false once data has
 *    landed, so a later refetch never falls back.
 *
 * The server's order is rendered as-is. Every section is recency-ordered now
 * that nothing writes `display_order` (LUM-3108).
 */
export function useSectionConversations(
  assistantId: string | null,
  section: SidebarSection,
): Conversation[] {
  const isAssistantActive = useAssistantLifecycleStore(
    (s) => s.assistantState.kind === "active",
  );
  const supportsGroupFilter = useSupportsGroupFilter(assistantId);

  // Memoized so the query options are not rebuilt on every render: the filter
  // is part of the query key, and a fresh object each render would churn it.
  const filter = useMemo(() => sectionFilter(section), [section]);

  const enabled = filter !== null && isAssistantActive && supportsGroupFilter;
  const { conversations, isPending } = useSectionConversationListQuery(
    assistantId,
    filter ?? NO_FILTER,
    enabled,
  );

  return enabled && !isPending ? conversations : section.all;
}
