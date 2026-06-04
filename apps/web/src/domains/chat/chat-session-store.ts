/**
 * Zustand store for per-conversation ephemeral chat session state.
 *
 * Owns the mutable data (messages, errors, pagination, transient maps/sets)
 * that hooks and stream handlers read and write during a conversation.
 *
 * Reactive state (messages, error, isLoadingHistory, …) drives UI via `.use.*`
 * selectors. Imperative-only state (streamingMessageIds, pendingLocalDeletions,
 * …) is read via `getState()` in async callbacks and stream handlers — it never
 * triggers re-renders directly.
 *
 * `switchToConversation()` atomically resets all per-conversation state when
 * the active conversation changes.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { loadDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { loadContextWindowUsageMap } from "@/domains/chat/utils/context-window-storage";
import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { recordDiagnostic } from "@/lib/diagnostics";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useConversationStore } from "@/stores/conversation-store";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { ChatError } from "@/domains/chat/types";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import type { TranscriptPaginationState } from "@/domains/chat/transcript/types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Reactive state — drives UI via `.use.*` selectors. */
export interface ChatSessionState {
  // --- Core message state ---
  messages: DisplayMessage[];
  error: ChatError | null;
  isLoadingHistory: boolean;

  // --- Pagination ---
  transcriptPagination: Omit<TranscriptPaginationState, "items">;

  // --- Context window ---
  contextWindowUsage: ContextWindowUsage | null;

  // --- Circuit breaker ---
  compactionCircuitOpenUntil: Date | null;

  // --- Per-conversation mutable maps/sets ---
  // Imperative-only: mutated in-place by stream handlers via getState().
  // Do not subscribe to these fields with .use.*() — mutations bypass
  // Zustand's set() and won't trigger re-renders.
  dismissedSurfaceIds: Set<string>;
  streamingMessageIds: Set<string>;
  pendingQueuedMessageIds: string[];
  requestIdToMessageId: Map<string, string>;
  pendingLocalDeletions: Set<string>;
  confirmationToolCallMap: Map<string, string>;
  expandedToolCallIds: Set<string>;
  /**
   * Persistent expand state for the activity/tool progress cards and thinking
   * blocks. Held in the store (not local `Transcript` state) so a user's
   * expand choice survives the transcript remount that happens when the
   * tool-detail drawer opens/closes (`mainView` change moves the chat content
   * in/out of the `ResizablePanel`). Keyed by the card's first tool-call id /
   * the thinking block's expansion key.
   */
  expandedCardIds: Map<string, boolean>;
  expandedThinkingKeys: Map<string, boolean>;

  // --- Cross-conversation cache ---
  contextWindowUsageByConversation: Map<string, ContextWindowUsage>;

  // --- Conversation switch coordination ---
  previousConversationId: string | null;
  previousAssistantId: string | null;
  draftConversationIdResolution: boolean;

  // --- History data-apply coordination ---
  /** True when the most recent switch-reset has fired and the data-apply
   *  effect hasn't yet consumed it. Consumers set this to `false` after
   *  using it so subsequent background refetches reconcile instead of
   *  replace. */
  switchResetPending: boolean;
  /** Timestamp (matching TanStack Query's `dataUpdatedAt`) of the last
   *  history payload applied. Reset to `0` on every switch so the next
   *  payload always triggers an apply. */
  lastAppliedDataTimestamp: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ChatSessionActions {
  // --- Setters ---
  setMessages: (updater: DisplayMessage[] | ((prev: DisplayMessage[]) => DisplayMessage[])) => void;
  setError: (updater: ChatError | null | ((prev: ChatError | null) => ChatError | null)) => void;
  setIsLoadingHistory: (value: boolean) => void;
  setTranscriptPagination: (
    updater:
      | Omit<TranscriptPaginationState, "items">
      | ((prev: Omit<TranscriptPaginationState, "items">) => Omit<TranscriptPaginationState, "items">),
  ) => void;
  setContextWindowUsage: (
    updater: ContextWindowUsage | null | ((prev: ContextWindowUsage | null) => ContextWindowUsage | null),
  ) => void;
  setCompactionCircuitOpenUntil: (
    updater: Date | null | ((prev: Date | null) => Date | null),
  ) => void;

  // --- Conversation lifecycle ---
  /**
   * Atomically reset all per-conversation state when switching to a new
   * conversation.
   *
   * Caller must pass `resetChatAttachments` because attachment state
   * lives outside this store (in `useChatAttachments`).
   */
  switchToConversation: (params: {
    assistantId: string;
    activeConversationId: string;
    resetChatAttachments: () => void;
  }) => void;

  /**
   * Mark a draft→server ID resolution so the next activeConversationId
   * change is not treated as a real conversation switch.
   */
  markDraftResolution: () => void;

  // --- Data-apply coordination ---
  consumeSwitchReset: () => void;
  setLastAppliedDataTimestamp: (ts: number) => void;
}

// ---------------------------------------------------------------------------
// Combined type
// ---------------------------------------------------------------------------

export type ChatSessionStore = ChatSessionState & ChatSessionActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_PAGINATION: Omit<TranscriptPaginationState, "items"> = {
  hasMore: false,
  oldestTimestamp: null,
  isLoadingOlder: false,
  isPinnedToLatest: true,
};

function initialState(): ChatSessionState {
  return {
    messages: [],
    error: null,
    isLoadingHistory: true,
    transcriptPagination: { ...INITIAL_PAGINATION },
    contextWindowUsage: null,
    compactionCircuitOpenUntil: null,
    dismissedSurfaceIds: new Set(),
    streamingMessageIds: new Set(),
    pendingQueuedMessageIds: [],
    requestIdToMessageId: new Map(),
    pendingLocalDeletions: new Set(),
    confirmationToolCallMap: new Map(),
    expandedToolCallIds: new Set(),
    expandedCardIds: new Map(),
    expandedThinkingKeys: new Map(),
    contextWindowUsageByConversation: new Map(),
    previousConversationId: null,
    previousAssistantId: null,
    draftConversationIdResolution: false,
    switchResetPending: false,
    lastAppliedDataTimestamp: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyUpdater<T>(current: T, updater: T | ((prev: T) => T)): T {
  return typeof updater === "function"
    ? (updater as (prev: T) => T)(current)
    : updater;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useChatSessionStoreBase = create<ChatSessionStore>()((set, get) => ({
  ...initialState(),

  // --- Setters ---
  setMessages: (updater) =>
    set((s) => ({ messages: applyUpdater(s.messages, updater) })),

  setError: (updater) =>
    set((s) => ({ error: applyUpdater(s.error, updater) })),

  setIsLoadingHistory: (value) =>
    set({ isLoadingHistory: value }),

  setTranscriptPagination: (updater) =>
    set((s) => ({
      transcriptPagination: applyUpdater(s.transcriptPagination, updater),
    })),

  setContextWindowUsage: (updater) =>
    set((s) => ({
      contextWindowUsage: applyUpdater(s.contextWindowUsage, updater),
    })),

  setCompactionCircuitOpenUntil: (updater) =>
    set((s) => ({
      compactionCircuitOpenUntil: applyUpdater(
        s.compactionCircuitOpenUntil,
        updater,
      ),
    })),

  // --- Conversation lifecycle ---
  switchToConversation: ({ assistantId, activeConversationId, resetChatAttachments }) => {
    const state = get();

    // Draft-key resolution (draft→server ID) is not a real switch.
    if (state.draftConversationIdResolution) {
      set({ draftConversationIdResolution: false });
      return;
    }

    // Track outgoing conversation's attention state.
    const outgoingConversationId = state.previousConversationId;
    const isConversationSwitch = Boolean(
      outgoingConversationId && outgoingConversationId !== activeConversationId,
    );
    if (isConversationSwitch && outgoingConversationId) {
      const interactionSnapshot = useInteractionStore.getState();
      if (interactionSnapshot.pendingSecret || interactionSnapshot.pendingConfirmation) {
        useConversationStore.getState().addAttentionConversationId(outgoingConversationId);
      }
    }

    // Re-hydrate from localStorage when the assistant changes (or on first
    // load) so persisted context-window data survives page reloads and
    // assistant switches.
    const isAssistantSwitch = state.previousAssistantId !== null
      && state.previousAssistantId !== assistantId;
    const needsHydration = isAssistantSwitch || state.previousAssistantId === null;

    recordDiagnostic("conversation_switch_reset", {
      assistantId,
      conversationId: activeConversationId,
      outgoingConversationId: outgoingConversationId ?? null,
    });

    // Reset all per-conversation state atomically.
    useTurnStore.getState().resetTurn();
    useInteractionStore.getState().resetAll();
    resetChatAttachments();

    const usageByConversation = needsHydration
      ? loadContextWindowUsageMap(assistantId)
      : state.contextWindowUsageByConversation;

    set({
      messages: [],
      error: shouldSuppressGenericChatErrorNotice(state.error) ? state.error : null,
      isLoadingHistory: true,
      transcriptPagination: { ...INITIAL_PAGINATION },
      contextWindowUsage:
        usageByConversation.get(activeConversationId) ?? null,
      compactionCircuitOpenUntil: null,
      dismissedSurfaceIds: loadDismissedSurfaceIds(assistantId, activeConversationId),
      streamingMessageIds: new Set(),
      pendingQueuedMessageIds: [],
      requestIdToMessageId: new Map(),
      pendingLocalDeletions: new Set(),
      confirmationToolCallMap: new Map(),
      expandedToolCallIds: new Set(),
      expandedCardIds: new Map(),
      expandedThinkingKeys: new Map(),
      contextWindowUsageByConversation: usageByConversation,
      previousConversationId: activeConversationId,
      previousAssistantId: assistantId,
      draftConversationIdResolution: false,
      switchResetPending: true,
      lastAppliedDataTimestamp: 0,
    });
  },

  markDraftResolution: () =>
    set({ draftConversationIdResolution: true }),

  // --- Data-apply coordination ---
  consumeSwitchReset: () =>
    set({ switchResetPending: false }),

  setLastAppliedDataTimestamp: (ts) =>
    set({ lastAppliedDataTimestamp: ts }),
}));

export const useChatSessionStore = createSelectors(useChatSessionStoreBase);
