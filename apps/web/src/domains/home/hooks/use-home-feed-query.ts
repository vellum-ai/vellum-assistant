import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchHomeFeed, triggerFeedAction, updateFeedItemStatus } from "../api";
import type {
  FeedItem,
  FeedItemStatus,
  HomeFeedResponse,
} from "@vellumai/assistant-api";
import { subscribe } from "@/lib/event-bus";
import { homeFeedQueryKey } from "@/lib/sync/query-tags";

/**
 * React Query hook for the home feed.
 *
 * Tracks time-away via the layout-scoped event bus (`"app.hidden"` +
 * `"app.resume"`) so the daemon can personalise the greeting and decide
 * which items to surface. The `"online"` resume signal is ignored for
 * elapsed-time tracking — only visibility / app-state transitions
 * record a `hiddenAt` mark, so a network blip while the tab is in the
 * foreground does not synthesise fake time-away.
 */
export function useHomeFeedQuery(assistantId: string | null) {
  const queryClient = useQueryClient();

  const hiddenAtRef = useRef<number | null>(null);
  const timeAwaySecondsRef = useRef(0);

  useEffect(() => {
    const unsubHidden = subscribe("app.hidden", () => {
      hiddenAtRef.current = Date.now();
    });

    const unsubResume = subscribe("app.resume", ({ signal }) => {
      if (signal === "online") return;
      if (hiddenAtRef.current === null) return;
      const elapsed = Math.round((Date.now() - hiddenAtRef.current) / 1000);
      timeAwaySecondsRef.current = elapsed;
      hiddenAtRef.current = null;

      if (assistantId) {
        void queryClient.invalidateQueries({
          queryKey: homeFeedQueryKey(assistantId),
        });
      }
    });

    return () => {
      unsubHidden();
      unsubResume();
    };
  }, [assistantId, queryClient]);

  const query = useQuery<HomeFeedResponse>({
    queryKey: homeFeedQueryKey(assistantId ?? ""),
    queryFn: () => fetchHomeFeed(assistantId!, timeAwaySecondsRef.current),
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
    mutationFn: ({ itemId, actionId }: { itemId: string; actionId: string }) =>
      triggerFeedAction(assistantId!, itemId, actionId),

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
