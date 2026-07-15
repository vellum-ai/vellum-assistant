/**
 * React data hook for the "View All Conversations" page.
 *
 * Composes every conversation-list query the sidebar can surface — the
 * foreground, background, and scheduled active lists plus the archived list —
 * via TanStack Query, merges them into a single deduped list, and derives the
 * filtered view from the active search text and the All/Active/Archived
 * filter. All three active lists are pulled here because the page promises
 * "every conversation": the foreground query alone omits active background
 * and scheduled rows, which live under their own cache keys. Extracted as a
 * hook because it does TanStack Query composition (per the domains/library/
 * `use-library-data.ts` precedent); the pure merge/filter helpers live in
 * `use-all-conversations-data.helpers.ts` so they can be unit-tested without
 * React and are re-exported here.
 */

import { useMemo, useState } from "react";

import {
  type ConversationFilter,
  filterBySearch,
  filterByState,
  isFatalError,
  mergeConversations,
} from "@/domains/settings/hooks/use-all-conversations-data.helpers";
import {
  useArchivedConversationListQuery,
  useBackgroundConversationListQuery,
  useConversationListQuery,
  useScheduledConversationListQuery,
} from "@/hooks/conversation-queries";

export {
  type AllConversationsRow,
  type ConversationFilter,
  filterBySearch,
  filterByState,
  mergeConversations,
} from "@/domains/settings/hooks/use-all-conversations-data.helpers";

export function useAllConversationsData(
  assistantId: string,
  initialFilter: ConversationFilter = "all",
) {
  const {
    conversations: active,
    isLoading: activeLoading,
    isError: activeError,
    refetch: refetchActive,
  } = useConversationListQuery(assistantId);

  // Background and scheduled rows also count as "active" conversations but
  // are cached separately, so the page fetches them explicitly (default
  // `enabled: true`) rather than lazily like the sidebar sections. They only
  // report loading state — a failure falls back to an empty list, matching
  // the sidebar's tolerance for a missing background/scheduled section.
  const { conversations: background, isLoading: backgroundLoading } =
    useBackgroundConversationListQuery(assistantId);

  const { conversations: scheduled, isLoading: scheduledLoading } =
    useScheduledConversationListQuery(assistantId);

  const {
    conversations: archived,
    isLoading: archivedLoading,
    isError: archivedError,
    refetch: refetchArchived,
  } = useArchivedConversationListQuery(assistantId);

  const [searchText, setSearchText] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>(initialFilter);

  const merged = useMemo(
    () => mergeConversations([active, background, scheduled], archived),
    [active, background, scheduled, archived],
  );

  const stateFiltered = useMemo(
    () => filterByState(merged, filter),
    [merged, filter],
  );

  const rows = useMemo(
    () => filterBySearch(stateFiltered, searchText),
    [stateFiltered, searchText],
  );

  const loading =
    activeLoading || backgroundLoading || scheduledLoading || archivedLoading;
  const error = isFatalError(filter, { activeError, archivedError });

  const refetch = () => {
    refetchActive();
    refetchArchived();
  };

  return {
    merged,
    rows,
    searchText,
    setSearchText,
    filter,
    setFilter,
    loading,
    error,
    refetch,
  };
}
