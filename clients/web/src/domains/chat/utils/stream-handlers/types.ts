import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { TurnActions, TurnState } from "@/domains/chat/turn-store";
import type { EndTurnArgs } from "@/domains/chat/turn-coordinator";
import type { ChatError } from "@/domains/chat/types";
import type { StreamContext } from "@/domains/chat/stream-store";

/** Minimal push-based navigation adapter for stream event handlers. */
export interface Router {
  push(href: string): void;
}

/**
 * Shared context passed to every domain handler function.
 * Built once per `handleStreamEvent` call from the hook's params and store.
 *
 * All state mutations go through store actions (not in-place mutation).
 * The context exposes action functions for collections that handlers write
 * to; handlers read store state via `getState()` when needed.
 */
export interface StreamHandlerContext {
  // --- Navigation ---
  router: Router;
  isNative: boolean;

  // --- Stream context (resolved from stream-store / resolved-assistants-store) ---
  streamContext: StreamContext | null;
  assistantId: string | null;

  // --- Optimistic user sends ---
  // The rendered transcript content (assistant rows, tool calls, surfaces,
  // echoed user rows) is owned by the rolling-snapshot reducer, which folds
  // every active-conversation event into the materialized snapshot in
  // `use-event-stream`. Handlers no longer mutate transcript content; they own
  // only the control-plane (turn/interaction stores, reconciliation, cache
  // patches) plus the unconfirmed optimistic sends below.
  /** Mutate the optimistic-send list — queue handlers retarget here (queue
   *  position / status / removal of a not-yet-confirmed user send), and the
   *  echo handler retires or upgrades the confirmed send. */
  setOptimisticSends: (
    updater: DisplayMessage[] | ((prev: DisplayMessage[]) => DisplayMessage[]),
  ) => void;

  // --- Turn state ---
  turnActions: TurnActions;
  getTurnState: () => TurnState;

  // --- Terminal-turn cleanup ---
  /**
   * Atomic two-store transition: terminal turn-store action +
   * `processingConversationIds` cleanup. Every terminal-event handler
   * (`handleAssistantActivityState(idle)`, `handleMessageComplete`,
   * `handleGenerationCancelled`, error handlers) goes through this
   * instead of calling the two stores independently — that prevented
   * the canonical "forget to clear the processing key" bug.
   */
  endTurn: (args: EndTurnArgs) => void;

  // --- Error & stream lifecycle ---
  setError: Dispatch<SetStateAction<ChatError | null>>;
  setNotice: Dispatch<SetStateAction<ChatError | null>>;
  /** Cancel the active SSE stream and clear the store's stream state. */
  cancelAndClearStream: () => void;

  // --- Reconciliation ---
  cancelReconciliation: () => void;
  startReconciliationLoop: (epoch: number) => void;

  // --- Interaction state ---
  setConfirmationToolCall: (requestId: string, toolCallId: string) => void;

  // --- UI surfaces ---
  setAssetsRefreshKey: Dispatch<SetStateAction<number>>;
  addDismissedSurfaceId: (surfaceId: string) => void;

  // --- Context window ---
  setContextWindowUsageForConversation: (conversationId: string, usage: ContextWindowUsage) => void;
  setContextWindowUsage: Dispatch<SetStateAction<ContextWindowUsage | null>>;

  // --- Conversations ---
  /** TanStack Query client used by conversation/group cache helpers. */
  queryClient: QueryClient;

  // --- Compaction ---
  setCompactionCircuitOpenUntil: Dispatch<SetStateAction<Date | null>>;

  // --- Queue management ---
  shiftPendingQueuedMessageId: () => string | undefined;
  setRequestIdMapping: (requestId: string, messageId: string) => void;
  popRequestIdMapping: (requestId: string) => string | undefined;
  consumePendingLocalDeletion: (messageId: string) => boolean;

  // --- Hook-owned refs ---
  lastActivityVersionRef: MutableRefObject<Map<string, number>>;

  // --- Synchronous message tracking ---
  /** Id of the current assistant message being streamed, stamped from the
   *  event's `messageId` (the row the daemon reserved at turn start). Read by
   *  `subagent_spawned` to attribute a nested notification to the right parent
   *  bubble, and by `message_complete` to re-anchor onto the durable server id.
   *  Mirrors macOS `currentAssistantMessageId`. */
  currentAssistantMessageIdRef: MutableRefObject<string | undefined>;
}
