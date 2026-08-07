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
  ORIGIN_CHANNELS,
  SYSTEM_ALL_GROUP_ID,
  SYSTEM_PINNED_GROUP_ID,
  type OriginChannel,
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
 * Pinned and the custom groups are answered by `groupId` alone, because
 * pinning is stored as group membership.
 *
 * A channel needs BOTH axes, which is why the filter is an object rather than
 * an id. `origin_channel` is a separate column from `group_id`, so a Slack
 * conversation the user filed into a custom group matches Slack's filter as
 * well as that group's; without `system:all` it would render in both cards and
 * break "a conversation appears in exactly one section".
 *
 * Chats has no filter yet. In Grouped view it is what no channel claimed,
 * which needs `originChannel: "vellum"` to also match rows that are not yet
 * attributed - a server predicate that has to land and be released before a
 * gate can name it.
 */
function sectionFilter(
  section: SidebarSection,
): SectionConversationFilter | null {
  switch (section.type) {
    case "pinned":
      return { groupId: SYSTEM_PINNED_GROUP_ID };
    case "group":
      return { groupId: section.group.id };
    case "channel":
      return isOriginChannel(section.channelId)
        ? { groupId: SYSTEM_ALL_GROUP_ID, originChannel: section.channelId }
        : null;
    case "recents":
      return null;
  }
}

/**
 * Whether the daemon's `originChannel` parameter accepts this id.
 *
 * A section's `channelId` is whatever `origin_channel` the loaded rows carried,
 * so it is a plain string; the query parameter is a closed set. An id outside
 * it (a channel this client's schema predates) keeps that section on its
 * derived rows rather than sending a value the server would reject.
 */
function isOriginChannel(
  channelId: string,
): channelId is NonNullable<OriginChannel> {
  return (ORIGIN_CHANNELS as readonly string[]).includes(channelId);
}

/**
 * The conversations to render for `section`.
 *
 * Falls back to the derived rows in four cases, all of which have to paint
 * something rather than an empty section:
 *
 * 1. **The section has no filter yet** (Chats).
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
 *    paints immediately and fills in.
 * 4. **The first fetch failed.** Same requirement as (3) and easy to miss for
 *    the opposite reason: a failed query is not pending, so branching on
 *    `isPending` alone lets the empty result through and the section is
 *    dropped. A section whose request failed shows what it can, not nothing.
 *
 * Note the asymmetry between (3)/(4) and a failed *refetch*, which does NOT
 * fall back: React Query keeps the last successful data, so those rows are
 * still the section's real membership and still beat the derived subset.
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
  const { conversations, hasData } = useSectionConversationListQuery(
    assistantId,
    filter ?? NO_FILTER,
    enabled,
  );

  /* `hasData`, not `!isPending`, and not `!isError` either.

     `!isPending` alone drops a failed first fetch into the empty result: the
     status is `error`, not `pending`, so the section renders zero rows and
     the hide-when-empty rule then removes it outright. One failed request
     would take Pinned, every custom group, and every channel section off both
     the sidebar and the rail while their conversations still existed.

     `!isError` overcorrects the other way. React Query keeps the last
     successful data when a later refetch fails, so an errored query is often
     still holding the section's real rows, and discarding them for the
     derived subset would shrink the section on any transient blip.

     "Has something to show" is the question, and it is false in exactly the
     three cases that need the fallback: never fetched, still pending, or
     failed before ever succeeding. */
  return enabled && hasData ? conversations : section.all;
}
