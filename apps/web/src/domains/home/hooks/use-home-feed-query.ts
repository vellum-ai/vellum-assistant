import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchHomeFeed,
  triggerFeedAction,
  updateFeedItemStatus,
} from "../api.js";
import type {
  FeedItem,
  FeedItemStatus,
  HomeFeedResponse,
} from "../types.js";

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
          items: old.items.map((item: FeedItem) =>
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
