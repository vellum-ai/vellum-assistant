/**
 * The All chats page's rows: the whole history, paged on scroll, with a
 * fallback for an assistant that cannot serve it in one read.
 *
 * The page reads `conversationType=all&archiveStatus=all`, which is one
 * recency-ordered cursor across every type and both archive states. An
 * assistant that predates that value rejects the request with a 400, so this
 * watches for exactly that answer and switches to the four bucket reads the
 * sidebar already fills, merged into the same recency order. No version gate:
 * the assistant's own refusal is the signal, which is what
 * `docs/BACKWARDS_COMPAT.md` asks for when the old behavior is a clean refusal
 * rather than a plausible-looking wrong answer.
 *
 * The degraded path drains four caches, so it is complete but unpaginated:
 * `hasMore` is false there and the page renders everything it was handed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import {
  useAllHistoryConversationListQuery,
  useArchivedConversationListQuery,
  useBackgroundConversationListQuery,
  useConversationListQuery,
  useScheduledConversationListQuery,
  useSectionConversationListQuery,
} from "@/hooks/conversation-queries";
import { useSupportsGroupFilter } from "@/lib/backwards-compat/use-supports-group-filter";
import { captureError } from "@/lib/sentry/capture-error";
import type { Conversation } from "@/types/conversation-types";
import { ApiError } from "@/utils/api-errors";
import { mergeConversationLists } from "@/utils/conversation-cache";
import { loadMoreConversations } from "@/utils/conversation-cache-mutations";
import { SYSTEM_ASSISTANT_GROUP_ID } from "@/utils/conversation-list-fetchers";
import {
  ALL_HISTORY_FILTER,
  type ConversationListFilter,
} from "@/utils/conversation-list-keys";
import { byTimestampDesc } from "@/utils/conversation-order";

function noop(): void {}

/**
 * The threads the assistant started on its own, as the sidebar's own section
 * asks for them. Module scope so the query key is stable across renders.
 */
const ASSISTANT_INITIATED_FILTER: ConversationListFilter = {
  groupId: SYSTEM_ASSISTANT_GROUP_ID,
};

/**
 * Whether this error is the assistant saying it does not know the combined
 * read. A 400 on this request can only be the rejected parameter: the route
 * takes no body, and the rest of the query is the shape every other list read
 * sends.
 */
export function isUnsupportedCombinedRead(error: Error | null): boolean {
  return error instanceof ApiError && error.status === 400;
}

export interface AllChatsData {
  conversations: Conversation[];
  /** Whether the server holds rows past the loaded window. */
  hasMore: boolean;
  /** Extend the window by one page. A no-op on the degraded path. */
  loadMore: () => void;
  /** Nothing to show yet, and a first read still in flight. */
  isLoading: boolean;
  /** Nothing to show, and the read that would have filled it failed. */
  isError: boolean;
  retry: () => void;
}

/**
 * @param enabled Whether the page is actually going to render. The route
 * gates this on the feature flag, since hooks run before its redirect and a
 * flag-off visit must not spend a whole-history request on its way out.
 */
export function useAllChatsData(
  assistantId: string | null,
  enabled: boolean = true,
): AllChatsData {
  const queryClient = useQueryClient();

  /* Which assistant refused the combined read, so the refusal survives the
     list invalidation every archive settle fires and is dropped when the
     active assistant changes. A capability fact about the connected
     assistant, not a copy of server data: the rows themselves are only ever
     read from the query caches below. */
  const [refusedBy, setRefusedBy] = useState<string | null>(null);
  const refused = refusedBy !== null && refusedBy === assistantId;

  const combined = useAllHistoryConversationListQuery(
    assistantId,
    enabled && !refused,
  );
  const combinedError = combined.error;
  useEffect(() => {
    if (assistantId && isUnsupportedCombinedRead(combinedError)) {
      setRefusedBy(assistantId);
    }
  }, [assistantId, combinedError]);

  const degraded = refused || isUnsupportedCombinedRead(combinedError);

  /* Mounted disabled on the supported path, where they subscribe to the
     caches the sidebar fills without issuing a request of their own. */
  const fetchBuckets = enabled && degraded;
  const foreground = useConversationListQuery(assistantId, fetchBuckets);
  const background = useBackgroundConversationListQuery(
    assistantId,
    fetchBuckets,
  );
  const scheduled = useScheduledConversationListQuery(
    assistantId,
    fetchBuckets,
  );
  const archived = useArchivedConversationListQuery(assistantId, fetchBuckets);

  /* A fifth source, and not an optional one: under `assistant-initiated-
     threads` the daemon withholds the threads the assistant started from
     every standard active read, so the foreground bucket above does not
     contain them and nothing else would. It withholds them only from the
     `standard` type, which is why the combined read needs no equivalent.

     Gated on the group filter the sidebar's sections already gate on: an
     assistant that ignores `groupId` answers 200 with the whole unfiltered
     list, and such an assistant also predates the split, so it has nothing
     to contribute here anyway. Unlike the four buckets this one is windowed
     rather than drained, and it is what the degraded path pages. */
  const supportsGroupFilter = useSupportsGroupFilter(assistantId);
  const assistantThreads = useSectionConversationListQuery(
    assistantId,
    ASSISTANT_INITIATED_FILTER,
    fetchBuckets && supportsGroupFilter,
  );

  const fallbackRows = useMemo(
    () =>
      [
        ...mergeConversationLists(
          foreground.conversations,
          background.conversations,
          scheduled.conversations,
          archived.conversations,
          assistantThreads.conversations,
        ),
      ].sort(byTimestampDesc("lastMessageAt")),
    [
      foreground.conversations,
      background.conversations,
      scheduled.conversations,
      archived.conversations,
      assistantThreads.conversations,
    ],
  );

  const extendList = useCallback(
    (filter: ConversationListFilter) => {
      if (!assistantId) {
        return;
      }
      loadMoreConversations(queryClient, assistantId, filter).catch(
        (error: unknown) => {
          /* Best effort: the page asks again as the window grows, so daemon
             transients filter out and only unexpected failures are reported. */
          captureError(error, {
            context: "useAllChatsData.loadMore",
            bestEffort: true,
          });
        },
      );
    },
    [assistantId, queryClient],
  );

  const loadMore = useCallback(() => {
    extendList(ALL_HISTORY_FILTER);
  }, [extendList]);

  const loadMoreAssistantThreads = useCallback(() => {
    extendList(ASSISTANT_INITIATED_FILTER);
  }, [extendList]);

  const refetchForeground = foreground.refetch;
  const refetchBackground = background.refetch;
  const refetchScheduled = scheduled.refetch;
  const refetchArchived = archived.refetch;
  const refetchAssistantThreads = assistantThreads.refetch;
  const retryDegraded = useCallback(() => {
    refetchForeground();
    refetchBackground();
    refetchScheduled();
    refetchArchived();
    refetchAssistantThreads();
  }, [
    refetchForeground,
    refetchBackground,
    refetchScheduled,
    refetchArchived,
    refetchAssistantThreads,
  ]);

  if (degraded) {
    return {
      conversations: fallbackRows,
      /* The four buckets drain, so the only source with pages left is the
         assistant-initiated section. */
      hasMore: assistantThreads.hasMore,
      loadMore: assistantThreads.hasMore ? loadMoreAssistantThreads : noop,
      /* Every source is part of the answer, so the view waits on all of them
         and fails if any of them fails: a missing source is missing rows the
         page claims to hold, which reads as "you have none". */
      isLoading:
        foreground.isLoading ||
        background.isLoading ||
        scheduled.isLoading ||
        archived.isLoading ||
        assistantThreads.isLoading,
      /* Guarded by `hasData` for the same reason the combined path below is:
         React Query keeps the last successful page, so a transient failure on
         a refetch must not replace a complete history with an error panel. */
      isError:
        (foreground.isError && !foreground.hasData) ||
        (background.isError && !background.hasData) ||
        (scheduled.isError && !scheduled.hasData) ||
        (archived.isError && !archived.hasData) ||
        (assistantThreads.isError && !assistantThreads.hasData),
      retry: retryDegraded,
    };
  }

  return {
    conversations: combined.conversations,
    hasMore: combined.hasMore,
    loadMore,
    isLoading: combined.isLoading,
    /* React Query keeps the last successful page when a refetch fails, so a
       blip must not swap real rows for an error panel. */
    isError: combined.isError && !combined.hasData,
    retry: combined.refetch,
  };
}
