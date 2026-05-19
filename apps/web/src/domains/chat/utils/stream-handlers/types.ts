import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";

import type { InteractionEvent } from "@/domains/interactions/interaction-store.js";
import type { SubagentAction } from "@/domains/subagents/subagent-store.js";
import type { ChatEventStream } from "@/domains/chat/lib/api.js";
import type { ConversationListAction } from "@/domains/conversations/conversation-list-store.js";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator.js";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { DomainEvent, TurnState } from "@/domains/messaging/turn-store.js";
import type { DiskPressureStatusEventPayload } from "@/domains/assistant/use-disk-pressure-monitor.js";
import type { ChatError, PendingQuestionState } from "@/domains/chat/types.js";

export type { PendingQuestionState };

export interface StreamContext {
  assistantId: string;
  conversationKey: string;
}

/**
 * Minimal push-based navigation adapter.
 *
 * Matches both Next.js App Router (`router.push`) and React Router v7
 * (`navigate`). Stream handlers only need forward navigation, so a
 * single `push` function is sufficient.
 */
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
  activeConversationKeyRef: MutableRefObject<string | null>;
  assistantIdRef: MutableRefObject<string | null>;

  // --- Messages ---
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  needsNewBubbleRef: MutableRefObject<boolean>;

  // --- Turn state ---
  dispatchTurn: Dispatch<DomainEvent>;
  turnStateRef: MutableRefObject<TurnState>;

  // --- Processing ---
  clearProcessingKey: (convKey: string) => void;

  // --- Error & stream lifecycle ---
  setError: Dispatch<SetStateAction<ChatError | null>>;
  streamRef: MutableRefObject<ChatEventStream | null>;

  // --- Reconciliation ---
  cancelReconciliation: () => void;
  startReconciliationLoop: (epoch: number) => void;

  // --- Interaction state ---
  dispatchInteraction: Dispatch<InteractionEvent>;
  confirmationToolCallMapRef: MutableRefObject<Map<string, string>>;

  // --- Subagent state ---
  dispatchSubagent: Dispatch<SubagentAction>;


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
  dispatchConversationList: Dispatch<ConversationListAction>;

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
