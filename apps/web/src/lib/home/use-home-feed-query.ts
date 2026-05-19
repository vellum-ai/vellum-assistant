
import { useCallback, useEffect, useRef } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchHomeFeed,
  triggerFeedAction,
  updateFeedItemStatus,
} from "@/lib/home/api.js";
import type {
  FeedItem,
  FeedItemStatus,
  HomeFeedResponse,
} from "@/lib/home/types.js";

const QUERY_KEY_PREFIX = "home-feed" as const;

function homeFeedQueryKey(assistantId: string) {
  return [QUERY_KEY_PREFIX, assistantId] as const;
}

/**
 * React Query hook for the home feed.
 *
 * Tracks time-away via `document.visibilitychange` so the daemon can
 * personalise the greeting and decide which items to surface.
 */
export function useHomeFeedQuery(assistantId: string | null) {
  const queryClient = useQueryClient();

  // Track seconds the tab has been hidden so we can pass it to the daemon.
  const hiddenAtRef = useRef<number | null>(null);
  const timeAwaySecondsRef = useRef(0);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
      } else if (hiddenAtRef.current !== null) {
        const elapsed = Math.round(
          (Date.now() - hiddenAtRef.current) / 1000,
        );
        timeAwaySecondsRef.current = elapsed;
        hiddenAtRef.current = null;

        // Refetch with fresh timeAway on return
        if (assistantId) {
          void queryClient.invalidateQueries({
            queryKey: homeFeedQueryKey(assistantId),
          });
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [assistantId, queryClient]);

  const query = useQuery<HomeFeedResponse>({
    queryKey: homeFeedQueryKey(assistantId ?? ""),
    queryFn: () =>
      fetchHomeFeed(assistantId!, timeAwaySecondsRef.current),
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });

  // --- Mutations with optimistic updates ---

  const updateStatus = useMutation({
    mutationFn: ({
      itemId,
      status,
    }: {
      itemId: string;
      status: FeedItemStatus;
    }) => updateFeedItemStatus(assistantId!, itemId, status),

    onMutate: async ({ itemId, status }) => {
      const key = homeFeedQueryKey(assistantId!);
      await queryClient.cancelQueries({ queryKey: key });

      const previous = queryClient.getQueryData<HomeFeedResponse>(key);

      queryClient.setQueryData<HomeFeedResponse>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: status === "dismissed"
            ? old.items.filter((item: FeedItem) => item.id !== itemId)
            : old.items.map((item: FeedItem) =>
                item.id === itemId ? { ...item, status } : item,
              ),
        };
      });

      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous && assistantId) {
        queryClient.setQueryData(
          homeFeedQueryKey(assistantId),
          context.previous,
        );
      }
    },

    onSettled: () => {
      if (assistantId) {
        void queryClient.invalidateQueries({
          queryKey: homeFeedQueryKey(assistantId),
        });
      }
    },
  });

  const triggerAction = useMutation({
    mutationFn: ({
      itemId,
      actionId,
    }: {
      itemId: string;
      actionId: string;
    }) => triggerFeedAction(assistantId!, itemId, actionId),

    onMutate: async ({ itemId }) => {
      const key = homeFeedQueryKey(assistantId!);
      await queryClient.cancelQueries({ queryKey: key });

      const previous = queryClient.getQueryData<HomeFeedResponse>(key);

      // Optimistically mark the item as acted_on
      queryClient.setQueryData<HomeFeedResponse>(key, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((item: FeedItem) =>
            item.id === itemId
              ? { ...item, status: "acted_on" as const }
              : item,
          ),
        };
      });

      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous && assistantId) {
        queryClient.setQueryData(
          homeFeedQueryKey(assistantId),
          context.previous,
        );
      }
    },

    onSettled: () => {
      if (assistantId) {
        void queryClient.invalidateQueries({
          queryKey: homeFeedQueryKey(assistantId),
        });
      }
    },
  });

  const invalidate = useCallback(() => {
    if (!assistantId) return;
    void queryClient.invalidateQueries({
      queryKey: homeFeedQueryKey(assistantId),
    });
  }, [assistantId, queryClient]);

  return {
    ...query,
    updateStatus,
    triggerAction,
    invalidate,
  };
}
