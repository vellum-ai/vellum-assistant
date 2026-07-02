/**
 * Zustand store for per-conversation ephemeral chat session state.
 *
 * Owns client-only state: the materialized transcript snapshot, the optimistic
 * user sends overlaid on it, errors, transient maps/sets, and UI expansion
 * state that hooks and stream handlers read and write during a conversation.
 * The rendered transcript is `snapshot ⊕ optimisticSends`, derived by
 * `selectTranscriptMessages` (see `useTranscriptMessages`).
 *
 * All mutations go through store actions that call `set()`, producing new
 * collection instances. Reactive state (snapshot, optimisticSends, error,
 * isLoadingHistory, …) drives UI via `.use.*` selectors. Non-reactive state
 * (streamingMessageIds,
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
import type {
  DisplayMessage,
  EphemeralMetaResult,
} from "@/domains/chat/types/types";
import type { ChatError } from "@/domains/chat/types";
import type { ContextWindowUsage } from "@/domains/chat/components/context-window-indicator";
import type {
  PaginatedHistoryResult,
  TranscriptPaginationState,
} from "@/domains/chat/transcript/types";
import { applyEvent, resolveSnapshot } from "@/domains/chat/transcript/rolling-snapshot";
import { messageMatchKeys } from "@/domains/chat/utils/message-identity";
import { getSseEnvelopesSince } from "@/lib/streaming/stream-debug";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Reactive state — drives UI via `.use.*` selectors. */
export interface ChatSessionState {
  // --- Materialized snapshot (client-sync rolling snapshot) ---
  // The client's living snapshot of the active conversation, in the `/messages`
  // page shape: seeded from a server snapshot and advanced by the stream reducer
  // (`applyEvent`). `null` until seeded. This is the single source the transcript
  // renders from, overlaid with `optimisticSends`.
  snapshot: PaginatedHistoryResult | null;
  // Optimistic user sends overlaid on the snapshot. Held apart from `snapshot`
  // so it's clear they're client-owned: the `user_message_echo` handler retires
  // a text-only send (or upgrades an attachment-carrying one, whose blob-URL
  // previews only this list holds), and the reseed prunes whatever the server
  // snapshot already represents.
  optimisticSends: DisplayMessage[];

  error: ChatError | null;
  notice: ChatError | null;
  isLoadingHistory: boolean;

  // --- Pagination ---
  transcriptPagination: Omit<TranscriptPaginationState, "items">;

  // --- Context window ---
  contextWindowUsage: ContextWindowUsage | null;

  // --- Ephemeral local meta-command results ---
  // Results of local meta slash commands (/clean, /status, /commands, /models),
  // rendered as cards at the transcript tail. Never persisted; cleared on the
  // next real send, conversation switch, or reload.
  ephemeralMetaResults: EphemeralMetaResult[];

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
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface ChatSessionActions {
  // --- Materialized snapshot ---
  /** Seed (or resync) the snapshot from a freshly fetched server snapshot,
   *  replaying the buffered event tail with `seq > snapshot.seq` onto it so
   *  events that raced the fetch aren't lost. A gap (evicted tail) falls back
   *  to the fetched snapshot alone. */
  seedSnapshot: (conversationId: string, snapshot: PaginatedHistoryResult) => void;
  /** Fold one live stream event into the snapshot (no-op until seeded; the
   *  seed's replay covers anything that arrived first). Idempotent by `seq`. */
  applyEnvelopeToSnapshot: (envelope: AssistantEventEnvelope) => void;
  /** Add an optimistic user send; retired by its echo or the reseed prune. */
  addOptimisticSend: (message: DisplayMessage) => void;
  /** Mutate the optimistic-send list (queue status, id swap, removal). */
  setOptimisticSends: (
    updater: DisplayMessage[] | ((prev: DisplayMessage[]) => DisplayMessage[]),
  ) => void;
  /** Apply an updater to the materialized snapshot's messages — the seam
   *  imperative actions (confirmation/surface/rule cleanup) reach server-
   *  confirmed rows through. No-op until the snapshot is seeded. */
  patchSnapshotMessages: (updater: (prev: DisplayMessage[]) => DisplayMessage[]) => void;
  setError: (updater: ChatError | null | ((prev: ChatError | null) => ChatError | null)) => void;
  setNotice: (updater: ChatError | null | ((prev: ChatError | null) => ChatError | null)) => void;
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

  // --- Ephemeral meta-command results ---
  addEphemeralMetaResult: (result: EphemeralMetaResult) => void;
  clearEphemeralMetaResults: () => void;
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
};

function initialState(): ChatSessionState {
  return {
    snapshot: null,
    optimisticSends: [],
    error: null,
    notice: null,
    isLoadingHistory: true,
    transcriptPagination: { ...INITIAL_PAGINATION },
    contextWindowUsage: null,
    ephemeralMetaResults: [],
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

/**
 * Drop optimistic sends the (re)seeded snapshot already represents.
 *
 * On a reconnect / replay-gap path the `user_message_echo` (or dequeue) that
 * would normally clear an optimistic send can be missed, while the authoritative
 * server snapshot — pulled in by the reseed — does carry the persisted row. The
 * overlay lets optimistic rows win by identity, so a confirmed send would
 * otherwise stay rendered as optimistic/queued indefinitely. Pruning by the same
 * match keys `selectTranscriptMessages` overlays on keeps the two in lockstep.
 */
function pruneConfirmedOptimisticSends(
  optimisticSends: DisplayMessage[],
  snapshotMessages: DisplayMessage[],
): DisplayMessage[] {
  if (optimisticSends.length === 0) return optimisticSends;
  const snapshotKeys = new Set<string>();
  for (const m of snapshotMessages) {
    for (const k of messageMatchKeys(m)) snapshotKeys.add(k);
  }
  const kept = optimisticSends.filter(
    (m) => !messageMatchKeys(m).some((k) => snapshotKeys.has(k)),
  );
  return kept.length === optimisticSends.length ? optimisticSends : kept;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useChatSessionStoreBase = create<ChatSessionStore>()((set, get) => ({
  ...initialState(),

  // --- Materialized snapshot ---
  seedSnapshot: (conversationId, snapshot) => {
    const tail = getSseEnvelopesSince(conversationId, snapshot.seq ?? null);
    const resolved = resolveSnapshot(snapshot, tail);
    set((s) => ({
      snapshot: resolved,
      optimisticSends: pruneConfirmedOptimisticSends(
        s.optimisticSends,
        resolved.messages,
      ),
    }));
  },

  applyEnvelopeToSnapshot: (envelope) =>
    set((s) => (s.snapshot ? { snapshot: applyEvent(s.snapshot, envelope) } : {})),

  addOptimisticSend: (message) =>
    set((s) => ({ optimisticSends: [...s.optimisticSends, message] })),

  setOptimisticSends: (updater) =>
    set((s) => ({ optimisticSends: applyUpdater(s.optimisticSends, updater) })),

  patchSnapshotMessages: (updater) =>
    set((s) =>
      s.snapshot
        ? { snapshot: { ...s.snapshot, messages: updater(s.snapshot.messages) } }
        : {},
    ),

  setError: (updater) =>
    set((s) => ({ error: applyUpdater(s.error, updater) })),

  setNotice: (updater) =>
    set((s) => ({ notice: applyUpdater(s.notice, updater) })),

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
      snapshot: null,
      optimisticSends: [],
      ephemeralMetaResults: [],
      error: shouldSuppressGenericChatErrorNotice(state.error) ? state.error : null,
      notice: null,
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

  // --- Ephemeral meta-command results ---
  addEphemeralMetaResult: (result) =>
    set((s) => ({
      ephemeralMetaResults: [...s.ephemeralMetaResults, result],
    })),

  clearEphemeralMetaResults: () =>
    set((s) =>
      s.ephemeralMetaResults.length === 0
        ? s
        : { ephemeralMetaResults: [] },
    ),
}));

export const useChatSessionStore = createSelectors(useChatSessionStoreBase);
