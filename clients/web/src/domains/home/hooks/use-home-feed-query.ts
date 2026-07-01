import { useCallback, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  homeFeedByIdActionsByActionIdPost,
  homeFeedByIdPatch,
  homeFeedGet,
  homeFeedMarkallPost,
} from "@/generated/daemon/sdk.gen";
import {
  homeFeedGetQueryKey,
  homeFeedGetSetQueryData,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  HomeFeedGetResponse,
  HomeFeedByIdPatchData,
  HomeFeedMarkallPostData,
} from "@/generated/daemon/types.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";

type FeedItemStatus = HomeFeedMarkallPostData["body"]["to"];

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

  // Stable query key — timeAwaySeconds is a fetch-time side-channel
  // (passed via ref), not a cache dimension, so the key uses a fixed
  // placeholder to keep a single cache entry per assistant.
  const feedOpts = useMemo(
    () => ({ path: { assistant_id: assistantId ?? "" }, query: { timeAwaySeconds: 0 } }),
    [assistantId],
  );
  const feedQueryKey = useMemo(
    () => homeFeedGetQueryKey(feedOpts),
    [feedOpts],
  );

  useBusSubscription("app.hidden", () => {
    hiddenAtRef.current = Date.now();
  });

  useBusSubscription("app.resume", ({ signal }) => {
    if (signal === "online") return;
    if (hiddenAtRef.current === null) return;
    const elapsed = Math.round((Date.now() - hiddenAtRef.current) / 1000);
    timeAwaySecondsRef.current = elapsed;
    hiddenAtRef.current = null;

    if (assistantId) {
      void queryClient.invalidateQueries({ queryKey: feedQueryKey });
    }
  });

  const query = useQuery({
    queryKey: feedQueryKey,
    queryFn: async ({ signal }) => {
      const { data } = await homeFeedGet({
        path: { assistant_id: assistantId! },
        query: { timeAwaySeconds: timeAwaySecondsRef.current },
        signal,
        throwOnError: true,
      });
      return data;
    },
    enabled: Boolean(assistantId),
    staleTime: 30_000,
  });

  const updateStatus = useMutation({
    mutationFn: async ({
      itemId,
      status,
    }: {
      itemId: string;
      status: HomeFeedByIdPatchData["body"]["status"];
    }) => {
      const { data } = await homeFeedByIdPatch({
        path: { assistant_id: assistantId!, id: itemId },
        body: { status },
        throwOnError: true,
      });
      return data;
    },

    onMutate: async ({ itemId, status }) => {
      await queryClient.cancelQueries({ queryKey: feedQueryKey });

      const previous = queryClient.getQueryData<HomeFeedGetResponse>(feedQueryKey);

      homeFeedGetSetQueryData(queryClient, feedOpts, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((item) =>
            item.id === itemId ? { ...item, status } : item,
          ),
        };
      });

      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        homeFeedGetSetQueryData(queryClient, feedOpts, context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: feedQueryKey });
    },
  });

  const triggerAction = useMutation({
    mutationFn: async ({
      itemId,
      actionId,
    }: {
      itemId: string;
      actionId: string;
    }) => {
      const { data } = await homeFeedByIdActionsByActionIdPost({
        path: {
          assistant_id: assistantId!,
          id: itemId,
          actionId,
        },
        throwOnError: true,
      });
      return data;
    },

    onMutate: async ({ itemId }) => {
      await queryClient.cancelQueries({ queryKey: feedQueryKey });

      const previous = queryClient.getQueryData<HomeFeedGetResponse>(feedQueryKey);

      homeFeedGetSetQueryData(queryClient, feedOpts, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((item) =>
            item.id === itemId
              ? { ...item, status: "acted_on" as const }
              : item,
          ),
        };
      });

      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        homeFeedGetSetQueryData(queryClient, feedOpts, context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: feedQueryKey });
    },
  });

  const markAll = useMutation({
    mutationFn: async ({
      from,
      to,
    }: {
      from: HomeFeedMarkallPostData["body"]["from"];
      to: FeedItemStatus;
    }) => {
      const { data } = await homeFeedMarkallPost({
        path: { assistant_id: assistantId! },
        body: { from, to },
        throwOnError: true,
      });
      return data;
    },

    onMutate: async ({ from, to }) => {
      await queryClient.cancelQueries({ queryKey: feedQueryKey });

      const previous = queryClient.getQueryData<HomeFeedGetResponse>(feedQueryKey);

      const fromSet = new Set<FeedItemStatus>(from);
      homeFeedGetSetQueryData(queryClient, feedOpts, (old) => {
        if (!old) return old;
        const items = old.items.map((item) =>
          fromSet.has(item.status) && item.status !== to
            ? { ...item, status: to }
            : item,
        );
        const newCount = items.filter((i) => i.status === "new").length;
        return {
          ...old,
          items,
          contextBanner: { ...old.contextBanner, newCount },
        };
      });

      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        homeFeedGetSetQueryData(queryClient, feedOpts, context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: feedQueryKey });
    },
  });

  const invalidate = useCallback(() => {
    if (!assistantId) return;
    void queryClient.invalidateQueries({ queryKey: feedQueryKey });
  }, [assistantId, queryClient, feedQueryKey]);

  return {
    ...query,
    updateStatus,
    triggerAction,
    markAll,
    invalidate,
  };
}
