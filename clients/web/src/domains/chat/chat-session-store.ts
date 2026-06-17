/**
 * Zustand store for per-conversation ephemeral chat session state.
 *
 * Owns the mutable data (messages, errors, pagination, transient maps/sets)
 * that hooks and stream handlers read and write during a conversation.
 *
 * All mutations go through store actions that call `set()`, producing new
 * collection instances. Reactive state (messages, error, isLoadingHistory, …)
 * drives UI via `.use.*` selectors. Non-reactive state (streamingMessageIds,
 * pendingLocalDeletions, …) is read via `getState()` in async callbacks and
 * stream handlers — it never triggers re-renders directly but still uses
 * actions for consistency and correctness.
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
import { useComposerStore } from "@/domains/chat/composer-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
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
  // Managed through store actions so mutations go through Zustand's set().
  // These fields are read via getState() in async callbacks and stream
  // handlers — they are not subscribed to reactively (no .use.*()).
  dismissedSurfaceIds: Set<string>;
  streamingMessageIds: Set<string>;
  pendingQueuedMessageIds: string[];
  requestIdToMessageId: Map<string, string>;
  pendingLocalDeletions: Set<string>;

  // --- Expansion state (subscribed reactively by leaf components) ---
  expandedToolCallIds: Set<string>;

  // --- Confirmation tool-call mapping ---
  // Managed through actions (setConfirmationToolCall, deleteConfirmationToolCall,
  // clearConfirmationToolCallMap) so mutations go through Zustand's set().
  confirmationToolCallMap: Map<string, string>;
  /**
   * Persistent expand state for the activity/tool progress cards. Held in the
   * store (not local `Transcript` state) so a user's expand choice survives the
   * transcript remount that happens when the tool-detail drawer opens/closes
   * (`mainView` change moves the chat content in/out of the `ResizablePanel`).
   * Keyed by the card's first tool-call id.
   */
  expandedCardIds: Map<string, boolean>;

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
   */
  switchToConversation: (params: {
    assistantId: string;
    activeConversationId: string;
  }) => void;

  /**
   * Mark a draft→server ID resolution so the next activeConversationId
   * change is not treated as a real conversation switch.
   */
  markDraftResolution: () => void;

  // --- Confirmation tool-call mapping ---
  setConfirmationToolCall: (requestId: string, toolCallId: string) => void;
  deleteConfirmationToolCall: (requestId: string) => void;
  clearConfirmationToolCallMap: () => void;

  // --- Dismissed surfaces ---
  addDismissedSurfaceId: (surfaceId: string) => void;
  addDismissedSurfaceIds: (surfaceIds: Iterable<string>) => void;

  // --- Streaming message tracking ---
  batchUpdateStreamingMessageIds: (toAdd: string[], toRemove: string[]) => void;

  // --- Queue management ---
  pushPendingQueuedMessageId: (messageId: string) => void;
  shiftPendingQueuedMessageId: () => string | undefined;
  setRequestIdMapping: (requestId: string, messageId: string) => void;
  popRequestIdMapping: (requestId: string) => string | undefined;
  addPendingLocalDeletion: (messageId: string) => void;
  consumePendingLocalDeletion: (messageId: string) => boolean;

  // --- Expansion state (tool calls, progress cards) ---
  setExpandedToolCallId: (toolCallId: string, expanded: boolean) => void;
  setExpandedCardId: (cardId: string, expanded: boolean) => void;

  // --- Context window cache ---
  setContextWindowUsageForConversation: (conversationId: string, usage: ContextWindowUsage) => void;

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
  switchToConversation: ({ assistantId, activeConversationId }) => {
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

    // Save outgoing draft, restore incoming draft.
    useComposerStore.getState().handleConversationSwitch({
      previousKey: outgoingConversationId ?? null,
      nextKey: activeConversationId,
    });

    // Reset all per-conversation state atomically.
    useTurnStore.getState().resetTurn();
    useInteractionStore.getState().resetAll();
    if (isAssistantSwitch) {
      // Assistant changed — old message bubbles leave the DOM, revoke blob URLs.
      useComposerStore.getState().fullReset();
    } else {
      // Same assistant, different conversation — keep blob URLs for sent messages.
      useComposerStore.getState().resetAttachments();
    }

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

  // --- Confirmation tool-call mapping ---
  setConfirmationToolCall: (requestId, toolCallId) =>
    set((s) => {
      const next = new Map(s.confirmationToolCallMap);
      next.set(requestId, toolCallId);
      return { confirmationToolCallMap: next };
    }),

  deleteConfirmationToolCall: (requestId) =>
    set((s) => {
      const next = new Map(s.confirmationToolCallMap);
      next.delete(requestId);
      return { confirmationToolCallMap: next };
    }),

  clearConfirmationToolCallMap: () =>
    set({ confirmationToolCallMap: new Map() }),

  // --- Dismissed surfaces ---
  addDismissedSurfaceId: (surfaceId) =>
    set((s) => {
      const next = new Set(s.dismissedSurfaceIds);
      next.add(surfaceId);
      return { dismissedSurfaceIds: next };
    }),

  addDismissedSurfaceIds: (surfaceIds) =>
    set((s) => {
      const next = new Set(s.dismissedSurfaceIds);
      for (const id of surfaceIds) next.add(id);
      return { dismissedSurfaceIds: next };
    }),

  // --- Streaming message tracking ---
  batchUpdateStreamingMessageIds: (toAdd, toRemove) =>
    set((s) => {
      const next = new Set(s.streamingMessageIds);
      for (const id of toAdd) next.add(id);
      for (const id of toRemove) next.delete(id);
      return { streamingMessageIds: next };
    }),

  // --- Queue management ---
  pushPendingQueuedMessageId: (messageId) =>
    set((s) => ({
      pendingQueuedMessageIds: [...s.pendingQueuedMessageIds, messageId],
    })),

  shiftPendingQueuedMessageId: () => {
    const current = get().pendingQueuedMessageIds;
    if (current.length === 0) return undefined;
    const [first, ...rest] = current;
    set({ pendingQueuedMessageIds: rest });
    return first;
  },

  setRequestIdMapping: (requestId, messageId) =>
    set((s) => {
      const next = new Map(s.requestIdToMessageId);
      next.set(requestId, messageId);
      return { requestIdToMessageId: next };
    }),

  popRequestIdMapping: (requestId) => {
    const current = get().requestIdToMessageId;
    const value = current.get(requestId);
    if (value !== undefined) {
      const next = new Map(current);
      next.delete(requestId);
      set({ requestIdToMessageId: next });
    }
    return value;
  },

  addPendingLocalDeletion: (messageId) =>
    set((s) => {
      const next = new Set(s.pendingLocalDeletions);
      next.add(messageId);
      return { pendingLocalDeletions: next };
    }),

  consumePendingLocalDeletion: (messageId) => {
    const current = get().pendingLocalDeletions;
    if (!current.has(messageId)) return false;
    const next = new Set(current);
    next.delete(messageId);
    set({ pendingLocalDeletions: next });
    return true;
  },

  // --- Expansion state (tool calls, progress cards, thinking blocks) ---
  setExpandedToolCallId: (toolCallId, expanded) =>
    set((s) => {
      const next = new Set(s.expandedToolCallIds);
      if (expanded) next.add(toolCallId);
      else next.delete(toolCallId);
      return { expandedToolCallIds: next };
    }),

  setExpandedCardId: (cardId, expanded) =>
    set((s) => {
      const next = new Map(s.expandedCardIds);
      next.set(cardId, expanded);
      return { expandedCardIds: next };
    }),

  // --- Context window cache ---
  setContextWindowUsageForConversation: (conversationId, usage) =>
    set((s) => {
      const next = new Map(s.contextWindowUsageByConversation);
      next.set(conversationId, usage);
      return { contextWindowUsageByConversation: next };
    }),

  // --- Data-apply coordination ---
  consumeSwitchReset: () =>
    set({ switchResetPending: false }),

  setLastAppliedDataTimestamp: (ts) =>
    set({ lastAppliedDataTimestamp: ts }),
}));

export const useChatSessionStore = createSelectors(useChatSessionStoreBase);
