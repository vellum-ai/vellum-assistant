/**
 * Orchestrates the message pipeline: reconciliation, sync router,
 * stream event handling, SSE subscription, and latest-message refresh.
 *
 * These hooks form a strict dependency chain where intermediate values
 * (dispatchSyncChanged, dispatchReconnect, handleStreamEvent) never
 * escape to the parent. Only the four values needed by external
 * consumers are exposed.
 */

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
} from "react";

import { useNavigate } from "react-router";

import { useIsNativePlatform } from "@/runtime/native-auth";
import { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation";
import { useSyncRouter } from "@/domains/chat/hooks/use-sync-router";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream";
import type { UseAssistantReachabilityResult } from "@/assistant/use-assistant-reachability";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseMessageLifecycleParams {
  assistantId: string | null;
  assistantStateKind: string;
  activeConversationId: string | null;
  conversationExistsOnServer: boolean;
  latestPageOldestTimestamp: number | null;
  cancelScheduledRefetch: () => void;
  reachability: UseAssistantReachabilityResult;
  reachabilityReadyEpoch: number;
  avatarInvalidate: () => void;
  setAssetsRefreshKey: Dispatch<SetStateAction<number>>;
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

export interface UseMessageLifecycleReturn {
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  reconcileActiveConversation: () => Promise<ReconcileActiveConversationResult>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMessageLifecycle({
  assistantId,
  assistantStateKind,
  activeConversationId,
  conversationExistsOnServer,
  latestPageOldestTimestamp,
  cancelScheduledRefetch,
  reachability,
  reachabilityReadyEpoch,
  avatarInvalidate,
  setAssetsRefreshKey,
}: UseMessageLifecycleParams): UseMessageLifecycleReturn {
  const navigate = useNavigate();
  const isNative = useIsNativePlatform();

  // Thin wrapper matching StreamHandlerContext.router.push signature.
  const push = useCallback(
    (url: string) => { void navigate(url); },
    [navigate],
  );

  // 1. Reconciliation — owns the merge loop that replays optimistic
  //    messages against the server transcript on reconnect.
  const {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  } = useMessageReconciliation({
    latestPageOldestTimestamp,
  });

  // 2. Sync router — owns identity invalidation, reachability refresh,
  //    and all sync_changed tag dispatch.
  const { dispatchSyncChanged, dispatchReconnect } = useSyncRouter({
    assistantId,
    reachabilityReadyEpoch,
    invalidateAvatar: avatarInvalidate,
    reconcileActiveConversation,
  });

  // 3. Stream event handler — routes incoming SSE events to domain
  //    handler functions (message, error, tool-call, metadata, etc.).
  const { handleStreamEvent } = useStreamEventHandler({
    push,
    isNative,
    cancelReconciliation,
    startReconciliationLoop,
    setAssetsRefreshKey,
    dispatchSyncChanged,
  });

  // 4. SSE subscription lifecycle — subscribes, filters, and tears down
  //    the bus-owned SSE for the active conversation.
  useEventStream({
    assistantStateKind,
    assistantId,
    activeConversationId,
    conversationExistsOnServer,
    handleStreamEvent,
    reconcileActiveConversation,
    startReconciliationLoop,
    cancelReconciliation,
    reachabilityProbe: reachability.probe,
    reachabilityPhase: reachability.state.phase,
    reachabilityReset: reachability.reset,
    dispatchReconnect,
    cancelScheduledRefetch,
  });

  return {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  };
}
