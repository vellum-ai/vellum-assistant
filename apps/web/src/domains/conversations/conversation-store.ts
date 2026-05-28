/**
 * Zustand store for the client-side slice of the conversations domain.
 *
 * Server-derived state (conversations, conversation groups) lives in
 * TanStack Query — see `conversation-queries.ts`. This store owns only
 * state that has no server counterpart:
 *
 * - `activeConversationId` — URL/navigation-local selection
 * - `editingConversationId` — UI mode (app-edit-chat target)
 * - `processingConversationIds` — in-flight assistant responses
 * - `processingSnapshots` — `latestAssistantMessageAt` snapshot taken when
 *   each conversation id was added to `processingConversationIds`; the
 *   attention-tracking graduation logic compares the current value against
 *   this snapshot to detect when the assistant has finished responding.
 *   Entries are added by `addProcessingConversationId` and cleared by every
 *   action that removes from `processingConversationIds`, so the two
 *   collections stay in sync.
 * - `attentionConversationIds` — conversations with pending interactions
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see ./conversation-queries.ts for the server-state half
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// Set / Map helpers — return the same reference when the mutation is a
// no-op so Zustand's shallow equality check can bail out of unnecessary
// re-renders.
// ---------------------------------------------------------------------------

function addToSet<T>(prev: Set<T>, key: T): Set<T> {
  if (prev.has(key)) return prev;
  const next = new Set(prev);
  next.add(key);
  return next;
}

function removeFromSet<T>(prev: Set<T>, key: T): Set<T> {
  if (!prev.has(key)) return prev;
  const next = new Set(prev);
  next.delete(key);
  return next;
}

function removeMultipleFromSet<T>(prev: Set<T>, keys: T[]): Set<T> {
  const toRemove = keys.filter((k) => prev.has(k));
  if (toRemove.length === 0) return prev;
  const next = new Set(prev);
  for (const k of toRemove) next.delete(k);
  return next;
}

function deleteFromMap<K, V>(prev: Map<K, V>, key: K): Map<K, V> {
  if (!prev.has(key)) return prev;
  const next = new Map(prev);
  next.delete(key);
  return next;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ConversationListState {
  activeConversationId: string | null;
  editingConversationId: string | null;
  processingConversationIds: Set<string>;
  processingSnapshots: Map<string, number | undefined>;
  attentionConversationIds: Set<string>;
}

export interface ConversationListActions {
  // --- Active / editing conversation id ---
  setActiveConversationId: (conversationId: string | null) => void;
  setEditingConversationId: (conversationId: string | null) => void;

  // --- Processing conversation ids (and their snapshots, kept atomic) ---
  addProcessingConversationId: (conversationId: string, snapshot?: number) => void;
  removeProcessingConversationId: (conversationId: string) => void;
  removeMultipleProcessingConversationIds: (conversationIds: string[]) => void;
  transferProcessingConversationId: (
    oldConversationId: string,
    newConversationId: string,
  ) => void;

  // --- Attention conversation ids ---
  addAttentionConversationId: (conversationId: string) => void;
  removeAttentionConversationId: (conversationId: string) => void;

  // --- Compound ---
  graduateProcessingConversationId: (
    conversationId: string,
    hasPendingInteraction: boolean,
  ) => void;

  // --- Reset ---
  reset: () => void;
}

type ConversationListStore = ConversationListState & ConversationListActions;

const INITIAL_STATE: ConversationListState = {
  activeConversationId: null,
  editingConversationId: null,
  processingConversationIds: new Set(),
  processingSnapshots: new Map(),
  attentionConversationIds: new Set(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConversationStore = createSelectors(
  create<ConversationListStore>((set, get) => ({
    ...INITIAL_STATE,

    // --- Active / editing conversation id ---

    setActiveConversationId: (conversationId) => {
      set({ activeConversationId: conversationId });
    },

    setEditingConversationId: (conversationId) => {
      set({ editingConversationId: conversationId });
    },

    // --- Processing conversation ids ---

    addProcessingConversationId: (conversationId, snapshot) => {
      const { processingConversationIds, processingSnapshots } = get();
      const nextSnapshots = new Map(processingSnapshots);
      nextSnapshots.set(conversationId, snapshot);
      set({
        processingConversationIds: addToSet(processingConversationIds, conversationId),
        processingSnapshots: nextSnapshots,
      });
    },

    removeProcessingConversationId: (conversationId) => {
      set({
        processingConversationIds: removeFromSet(get().processingConversationIds, conversationId),
        processingSnapshots: deleteFromMap(get().processingSnapshots, conversationId),
      });
    },

    removeMultipleProcessingConversationIds: (conversationIds) => {
      const { processingConversationIds, processingSnapshots } = get();
      let nextSnapshots = processingSnapshots;
      for (const id of conversationIds) {
        nextSnapshots = deleteFromMap(nextSnapshots, id);
      }
      set({
        processingConversationIds: removeMultipleFromSet(
          processingConversationIds,
          conversationIds,
        ),
        processingSnapshots: nextSnapshots,
      });
    },

    transferProcessingConversationId: (oldConversationId, newConversationId) => {
      const { processingConversationIds, processingSnapshots } = get();
      if (!processingConversationIds.has(oldConversationId)) return;
      const nextIds = new Set(processingConversationIds);
      nextIds.delete(oldConversationId);
      nextIds.add(newConversationId);
      const nextSnapshots = new Map(processingSnapshots);
      const snapshot = nextSnapshots.get(oldConversationId);
      nextSnapshots.delete(oldConversationId);
      nextSnapshots.set(newConversationId, snapshot);
      set({ processingConversationIds: nextIds, processingSnapshots: nextSnapshots });
    },

    // --- Attention conversation ids ---

    addAttentionConversationId: (conversationId) => {
      set({ attentionConversationIds: addToSet(get().attentionConversationIds, conversationId) });
    },

    removeAttentionConversationId: (conversationId) => {
      set({
        attentionConversationIds: removeFromSet(
          get().attentionConversationIds,
          conversationId,
        ),
      });
    },

    // --- Compound ---

    graduateProcessingConversationId: (conversationId, hasPendingInteraction) => {
      set((state) => ({
        processingConversationIds: removeFromSet(
          state.processingConversationIds,
          conversationId,
        ),
        processingSnapshots: deleteFromMap(state.processingSnapshots, conversationId),
        attentionConversationIds: hasPendingInteraction
          ? addToSet(state.attentionConversationIds, conversationId)
          : state.attentionConversationIds,
      }));
    },

    // --- Reset ---

    reset: () => {
      set({
        ...INITIAL_STATE,
        processingConversationIds: new Set(),
        processingSnapshots: new Map(),
        attentionConversationIds: new Set(),
      });
    },
  })),
);
