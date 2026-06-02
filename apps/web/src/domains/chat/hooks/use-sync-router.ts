/**
 * Owns the WebSyncRouter lifecycle — creation, disposal, and the
 * stable dispatch callbacks consumed by the stream event handler and
 * the reconnect-reconcile module.
 *
 * The sync router maps `sync_changed` SSE tags to invalidation handlers
 * (avatar, identity, conversation list, etc.) so that the chat UI stays
 * consistent with server-side state changes.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  createWebSyncRouter,
  type ActiveConversationMessagesRefreshResult,
  type WebSyncReconnectResult,
  type WebSyncRouter,
} from "@/lib/sync/web-sync-router";
import type { SyncChangedEvent } from "@/lib/sync/types";

export interface UseSyncRouterOptions {
  invalidateAvatar: () => void;
  refreshAssistantIdentity: () => Promise<void>;
  invalidateAssistantIdentityIntro: () => void;
  scheduleConversationListRefetch: () => void;
  reconcileActiveConversation: () => Promise<ActiveConversationMessagesRefreshResult>;
}

export interface UseSyncRouterResult {
  dispatchSyncChanged: (event: SyncChangedEvent) => void;
  dispatchReconnect: () => Promise<WebSyncReconnectResult | undefined>;
}

export function useSyncRouter({
  invalidateAvatar,
  refreshAssistantIdentity,
  invalidateAssistantIdentityIntro,
  scheduleConversationListRefetch,
  reconcileActiveConversation,
}: UseSyncRouterOptions): UseSyncRouterResult {
  const syncRouterRef = useRef<WebSyncRouter | null>(null);

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
