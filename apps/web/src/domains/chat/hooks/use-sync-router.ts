/**
 * Owns the WebSyncRouter lifecycle — creation, disposal, and the
 * stable dispatch callbacks consumed by the stream event handler and
 * the reconnect-reconcile module.
 *
 * The sync router maps `sync_changed` SSE tags to invalidation handlers
 * (avatar, identity, conversation list, etc.) so that the chat UI stays
 * consistent with server-side state changes.
 *
 * Also owns the assistant-identity invalidation callbacks and the
 * reachability-triggered refresh effect, since these are consumed
 * exclusively by the sync router's tag handlers.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  createWebSyncRouter,
  type ActiveConversationMessagesRefreshResult,
  type WebSyncReconnectResult,
  type WebSyncRouter,
} from "@/lib/sync/web-sync-router";
import type { SyncChangedEvent } from "@/lib/sync/types";
import {
  assistantIdentityIntroQueryKey,
  assistantIdentityQueryKey,
} from "@/lib/sync/query-tags";

export interface UseSyncRouterOptions {
  assistantId: string | null;
  reachabilityReadyEpoch: number;
  invalidateAvatar: () => void;
  scheduleConversationListRefetch: () => void;
  reconcileActiveConversation: () => Promise<ActiveConversationMessagesRefreshResult>;
}

export interface UseSyncRouterResult {
  dispatchSyncChanged: (event: SyncChangedEvent) => void;
  dispatchReconnect: () => Promise<WebSyncReconnectResult | undefined>;
}

export function useSyncRouter({
  assistantId,
  reachabilityReadyEpoch,
  invalidateAvatar,
  scheduleConversationListRefetch,
  reconcileActiveConversation,
}: UseSyncRouterOptions): UseSyncRouterResult {
  const queryClient = useQueryClient();
  const syncRouterRef = useRef<WebSyncRouter | null>(null);
  const assistantIdRef = useRef(assistantId);
  useLayoutEffect(() => {
    assistantIdRef.current = assistantId;
  }, [assistantId]);

  // Stable identity-invalidation callbacks used by the sync router's
  // tag handlers. Reading `assistantIdRef.current` at call time ensures
  // the latest assistant ID without recreating the router on every
  // assistant change.
  const refreshAssistantIdentity = useCallback(
    async () => {
      const targetId = assistantIdRef.current;
      if (!targetId) return;
      await queryClient.invalidateQueries({
        queryKey: assistantIdentityQueryKey(targetId),
      });
    },
    [queryClient],
  );

  const invalidateAssistantIdentityIntro = useCallback(
    () => {
      const targetId = assistantIdRef.current;
      if (!targetId) return;
      void queryClient.invalidateQueries({
        queryKey: assistantIdentityIntroQueryKey(targetId),
      });
    },
    [queryClient],
  );

  // Refresh identity when the assistant changes or reachability recovers.
  // The layout-level TanStack Query handles the initial fetch; this covers
  // SSE identity_changed, post-edit flushes, and reachability resumes.
  useEffect(() => {
    if (!assistantId) return;
    void refreshAssistantIdentity();
  }, [assistantId, reachabilityReadyEpoch, refreshAssistantIdentity]);

  useEffect(() => {
    const syncRouter = createWebSyncRouter({
      invalidateAvatar,
      refreshAssistantIdentity,
      invalidateAssistantIdentityIntro,
      scheduleConversationListRefetch,
      refreshActiveConversationMessages: reconcileActiveConversation,
    });
    syncRouterRef.current = syncRouter;
    return () => {
      if (syncRouterRef.current === syncRouter) {
        syncRouterRef.current = null;
      }
      syncRouter.dispose();
    };
  }, [
    invalidateAvatar,
    refreshAssistantIdentity,
    invalidateAssistantIdentityIntro,
    scheduleConversationListRefetch,
    reconcileActiveConversation,
  ]);

  const dispatchSyncChanged = useCallback(
    (event: SyncChangedEvent) => { void syncRouterRef.current?.dispatchSyncChanged(event); },
    [],
  );

  const dispatchReconnect = useCallback(
    () => syncRouterRef.current?.dispatchReconnect() ?? Promise.resolve(undefined),
    [],
  );

  return { dispatchSyncChanged, dispatchReconnect };
}
