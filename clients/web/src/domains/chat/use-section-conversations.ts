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

import { useCallback, useMemo } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useSectionConversationListQuery } from "@/hooks/conversation-queries";
import { useSupportsGroupFilter } from "@/lib/backwards-compat/use-supports-group-filter";
import { useSupportsNativeOriginFilter } from "@/lib/backwards-compat/use-supports-native-origin-filter";
import type { Conversation } from "@/types/conversation-types";
import { captureError } from "@/lib/sentry/capture-error";
import { loadMoreConversations } from "@/utils/conversation-cache-mutations";
import {
  NATIVE_ORIGIN_CHANNEL,
  ORIGIN_CHANNELS,
  SYSTEM_ALL_GROUP_ID,
  SYSTEM_PINNED_GROUP_ID,
  drainConversationList,
  type ConversationListPage,
  type OriginChannel,
} from "@/utils/conversation-list-fetchers";
import {
  type ConversationListFilter,
  conversationListQueryKey,
} from "@/utils/conversation-list-keys";

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
 * Chats is what nothing else claimed: ungrouped and native. It carries the
 * same two axes as a channel, with `vellum` as the channel, which is why it
 * needs `supportsNativeOrigin`. Below that gate `vellum` is a strict equality
 * on the daemon and matches only explicitly stamped rows, so asking for it
 * would return a fraction of the section and look like a quiet account rather
 * than a broken filter. Chats stays on its derived rows there.
 *
 * Chats is a section in both views, and both are wired here: `holdsChannels`
 * below is which of the two it is asking as.
 *
 * One asymmetry to know about, because it looks like a bug from either side.
 * `Conversation.originChannel` is binding-first on the client
 * (`channelBinding.sourceChannel ?? conversationOriginChannel`, see
 * `toConversation`), while these filters are matched against the
 * `origin_channel` column alone. The two agree once a conversation's first
 * inbound message stamps the column, and diverge before that: a row whose
 * binding already names a channel but whose column is still unattributed
 * derives into that channel's section and is fetched into Chats, since an
 * unattributed column reads as native. Transient, self-correcting when the
 * message lands, and in the safe direction: the row is in exactly one
 * section throughout, never zero and never two.
 */
function sectionFilter(
  section: SidebarSection,
  supportsNativeOrigin: boolean,
): ConversationListFilter | null {
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
      /* Ungrouped, Chats is every ungrouped conversation whatever its origin,
         so it must not narrow to the native channel - there are no channel
         sections to hold the rest, and narrowing would drop them from the
         sidebar entirely. Grouped, the channel sections own theirs and this
         one takes only what is left. */
      if (section.holdsChannels) {
        return { groupId: SYSTEM_ALL_GROUP_ID };
      }
      return supportsNativeOrigin
        ? {
            groupId: SYSTEM_ALL_GROUP_ID,
            originChannel: NATIVE_ORIGIN_CHANNEL,
          }
        : null;
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

/** What a section renders and how it pages; see {@link useSectionConversations}. */
export interface SectionConversationsResult {
  conversations: Conversation[];
  /**
   * Whether the server holds rows past the loaded window (LUM-2444).
   * `false` whenever the section is on its derived fallback rows, which
   * come from the drained foreground list and have no pages to load.
   */
  hasMore: boolean;
  /**
   * Extend the window by one page. Safe to call redundantly: the fetch is
   * guarded per section, and a call against a complete or unfetched cache
   * is a no-op. Failures are recorded, not thrown - the sentinel that
   * drives this retries on the next scroll intersection.
   */
  loadMore: () => void;
  /**
   * Every member of this section, drained at call time, for the bulk
   * actions ("archive all", "mark all read") whose completeness must not
   * shrink to the loaded window: both send explicit id lists, so what this
   * returns is exactly what they cover. Resolves to the rendered rows
   * whenever they are already complete.
   */
  getAllRows: () => Promise<Conversation[]>;
}

/**
 * The conversations to render for `section`.
 *
 * Falls back to the derived rows in four cases, all of which have to paint
 * something rather than an empty section:
 *
 * 1. **The section has no filter.** A channel whose id this client's schema
 *    does not carry, and Chats on an assistant below the native-origin gate.
 * 2. **The group gate is closed.** An assistant that predates the `groupId`
 *    filter ignores the unrecognized parameter and answers 200 with the
 *    *entire* conversation list, which would render in full inside one
 *    section. Both gates are assistant-scoped, so a version still held for
 *    the outgoing assistant cannot authorize a filtered fetch against the
 *    incoming one.
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
): SectionConversationsResult {
  const queryClient = useQueryClient();
  const isAssistantActive = useAssistantLifecycleStore(
    (s) => s.assistantState.kind === "active",
  );
  const supportsGroupFilter = useSupportsGroupFilter(assistantId);
  /* Chats additionally needs the daemon to read an unattributed row as
     native. Strictly later than the group gate on the same base version, so
     anything passing this passes that. */
  const supportsNativeOrigin = useSupportsNativeOriginFilter(assistantId);

  // Memoized so the query options are not rebuilt on every render: the filter
  // is part of the query key, and a fresh object each render would churn it.
  const filter = useMemo(
    () => sectionFilter(section, supportsNativeOrigin),
    [section, supportsNativeOrigin],
  );

  const enabled = filter !== null && isAssistantActive && supportsGroupFilter;
  const { conversations, hasData, hasMore } = useSectionConversationListQuery(
    assistantId,
    filter,
    enabled,
  );
  const live = enabled && hasData;

  const loadMore = useCallback(() => {
    if (!assistantId || filter === null) {
      return;
    }
    loadMoreConversations(queryClient, assistantId, filter).catch(
      (error: unknown) => {
        /* Best-effort: the sentinel re-fires on the next intersection, so
           daemon transients filter out and only unexpected failures reach
           Sentry. */
        captureError(error, {
          context: "useSectionConversations.loadMore",
          bestEffort: true,
        });
      },
    );
  }, [assistantId, filter, queryClient]);

  const sectionAll = section.all;
  const getAllRows = useCallback(async (): Promise<Conversation[]> => {
    if (!assistantId || filter === null || !live) {
      /* Derived rows come from the drained foreground list; they are the
         complete membership on this path. */
      return sectionAll;
    }
    const page = queryClient.getQueryData<ConversationListPage>(
      conversationListQueryKey(assistantId, filter),
    );
    if (page && !page.hasMore) {
      return page.conversations;
    }
    return drainConversationList(assistantId, filter);
  }, [assistantId, filter, live, queryClient, sectionAll]);

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
  const rows = live ? conversations : sectionAll;
  const windowed = live ? hasMore : false;
  return useMemo(
    () => ({ conversations: rows, hasMore: windowed, loadMore, getAllRows }),
    [rows, windowed, loadMore, getAllRows],
  );
}
