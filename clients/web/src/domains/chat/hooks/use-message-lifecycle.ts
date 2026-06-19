/**
 * Orchestrates the message pipeline: reconciliation, stream event
 * handling, SSE subscription, active-conversation message sync, and
 * latest-message refresh.
 *
 * These hooks form a strict dependency chain where intermediate values
 * (handleStreamEvent) never escape to the parent. Only the values
 * needed by external consumers are exposed.
 */

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
} from "react";

import { useNavigate } from "react-router";

import { useIsNativePlatform } from "@/runtime/native-auth";
import { useMessageReconciliation } from "@/domains/chat/hooks/use-message-reconciliation";
import { useStreamEventHandler } from "@/domains/chat/hooks/use-stream-event-handler";
import { useEventStream } from "@/domains/chat/hooks/use-event-stream";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { getClientId } from "@/lib/telemetry/client-identity";
import { parseConversationSyncTag } from "@/lib/sync/types";
import { useConversationStore } from "@/stores/conversation-store";
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
  reachability: UseAssistantReachabilityResult;
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
  reachability,
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

  // 2. Stream event handler — routes incoming SSE events to domain
  //    handler functions (message, error, tool-call, metadata, etc.).
  const { handleStreamEvent } = useStreamEventHandler({
    push,
    isNative,
    cancelReconciliation,
    startReconciliationLoop,
    setAssetsRefreshKey,
  });

  // 3. SSE subscription lifecycle — subscribes, filters, and tears down
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
  });

  // 4. Active-conversation `:messages` sync — when another client writes
  //    to the active conversation, a `sync_changed` event carries a
  //    `conversation:<id>:messages` tag. Reconcile the active conversation
  //    so the user sees the new messages without a manual refresh.
  //    Self-echo suppression mirrors the guard in useConversationSync.
  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId) return;
    const event = envelope.message;
    if (event.type !== "sync_changed") return;
    if (event.originClientId && event.originClientId === getClientId()) return;
    const currentActiveId = useConversationStore.getState().activeConversationId;
    if (!currentActiveId) return;
    for (const tag of event.tags) {
      const parsed = parseConversationSyncTag(tag);
      if (
        parsed &&
        parsed.resource === "messages" &&
        parsed.conversationId === currentActiveId
      ) {
        void reconcileActiveConversation();
        return;
      }
    }
  });

  return {
    startReconciliationLoop,
    cancelReconciliation,
    reconcileActiveConversation,
  };
}
