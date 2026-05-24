import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { TurnActions, TurnState } from "@/domains/messaging/turn-store.js";
import type { DiskPressureStatusEventPayload } from "@/assistant/use-disk-pressure-monitor.js";
import type { ChatError, PendingQuestionState } from "@/domains/chat/types.js";
import type { ChatEventStream } from "@/domains/chat/api/stream.js";

export type { PendingQuestionState };

export interface StreamContext {
  assistantId: string;
  conversationId: string;
}

/** Minimal push-based navigation adapter for stream event handlers. */
export interface Router {
  push(href: string): void;
}

/**
 * Shared context passed to every domain handler function.
 * Built once per `handleStreamEvent` call from the hook's params and refs.
 */
export interface StreamHandlerContext {
  // --- Navigation ---
  router: Router;
  isNative: boolean;

  // --- Stream context ---
  streamContextRef: MutableRefObject<StreamContext | null>;
  activeConversationIdRef: MutableRefObject<string | null>;
  assistantIdRef: MutableRefObject<string | null>;

  // --- Messages ---
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  messagesRef: MutableRefObject<DisplayMessage[]>;

  // --- Turn state ---
  turnActions: TurnActions;
  getTurnState: () => TurnState;

  // --- Processing ---
  clearProcessingKey: (convKey: string) => void;

  // --- Error & stream lifecycle ---
  setError: Dispatch<SetStateAction<ChatError | null>>;
  streamRef: MutableRefObject<ChatEventStream | null>;

  // --- Reconciliation ---
  cancelReconciliation: () => void;
  startReconciliationLoop: (epoch: number) => void;

  // --- Interaction state ---
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;

  // --- UI surfaces ---
  setAssetsRefreshKey: Dispatch<SetStateAction<number>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;

  // --- Context window ---
  contextWindowUsageByConversationRef: MutableRefObject<
    Map<string, ContextWindowUsage>
  >;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;

  // --- Conversations ---
  scheduleConversationListRefetch: () => void;
  /** TanStack Query client used by conversation/group cache helpers. */
  queryClient: QueryClient;

  // --- Compaction ---
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  // --- External callbacks ---
  applyDiskPressureStatusEvent: (
    payload: DiskPressureStatusEventPayload,
  ) => void;
  refreshAssistantIdentity: (force?: boolean) => Promise<void>;
  invalidateAvatar: () => void;

  // --- Queue management ---
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;

  // --- Hook-owned refs ---
  lastActivityVersionRef: MutableRefObject<Map<string, number>>;
  toolCallIdCounterRef: MutableRefObject<number>;

  // --- Synchronous message tracking ---
  /** StableId of the current assistant message being streamed.
   *  Updated synchronously at dispatch time (before setMessages) so
   *  subagent_spawned can read the correct parent without waiting for
   *  React's batched render. Mirrors macOS `currentAssistantMessageId`. */
  currentAssistantStableIdRef: MutableRefObject<string | undefined>;
}
