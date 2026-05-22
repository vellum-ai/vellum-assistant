/**
 * Zustand store for the client-side slice of the conversations domain.
 *
 * Server-derived state (conversations, conversation groups) lives in
 * TanStack Query — see `conversation-queries.ts`. This store owns only
 * state that has no server counterpart:
 *
 * - `activeConversationKey` — URL/navigation-local selection
 * - `editingConversationKey` — UI mode (app-edit-chat target)
 * - `processingKeys` — in-flight assistant responses
 * - `processingSnapshots` — `latestAssistantMessageAt` snapshot taken when
 *   each key was added to `processingKeys`; the attention-tracking
 *   graduation logic compares the current value against this snapshot to
 *   detect when the assistant has finished responding. Entries are added
 *   by `addProcessingKey` and cleared by every action that removes from
 *   `processingKeys`, so the two collections stay in sync.
 * - `attentionKeys` — conversations with pending interactions
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see ./conversation-queries.ts for the server-state half
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

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
  activeConversationKey: string | null;
  editingConversationKey: string | null;
  processingKeys: Set<string>;
  processingSnapshots: Map<string, string | undefined>;
  attentionKeys: Set<string>;
}

export interface ConversationListActions {
  // --- Active / editing key ---
  setActiveKey: (key: string | null) => void;
  setEditingKey: (key: string | null) => void;

  // --- Processing keys (and their snapshots, kept atomic) ---
  addProcessingKey: (key: string, snapshot?: string) => void;
  removeProcessingKey: (key: string) => void;
  removeMultipleProcessingKeys: (keys: string[]) => void;
  transferProcessingKey: (oldKey: string, newKey: string) => void;

  // --- Attention keys ---
  addAttentionKey: (key: string) => void;
  removeAttentionKey: (key: string) => void;

  // --- Compound ---
  graduateProcessingKey: (key: string, hasPendingInteraction: boolean) => void;

  // --- Reset ---
  reset: () => void;
}

type ConversationListStore = ConversationListState & ConversationListActions;

const INITIAL_STATE: ConversationListState = {
  activeConversationKey: null,
  editingConversationKey: null,
  processingKeys: new Set(),
  processingSnapshots: new Map(),
  attentionKeys: new Set(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConversationStore = createSelectors(
  create<ConversationListStore>((set, get) => ({
    ...INITIAL_STATE,

    // --- Active / editing key ---

    setActiveKey: (key) => {
      set({ activeConversationKey: key });
    },

    setEditingKey: (key) => {
      set({ editingConversationKey: key });
    },

    // --- Processing keys ---

    addProcessingKey: (key, snapshot) => {
      const { processingKeys, processingSnapshots } = get();
      const nextSnapshots = new Map(processingSnapshots);
      nextSnapshots.set(key, snapshot);
      set({
        processingKeys: addToSet(processingKeys, key),
        processingSnapshots: nextSnapshots,
      });
    },

    removeProcessingKey: (key) => {
      set({
        processingKeys: removeFromSet(get().processingKeys, key),
        processingSnapshots: deleteFromMap(get().processingSnapshots, key),
      });
    },

    removeMultipleProcessingKeys: (keys) => {
      const { processingKeys, processingSnapshots } = get();
      let nextSnapshots = processingSnapshots;
      for (const key of keys) {
        nextSnapshots = deleteFromMap(nextSnapshots, key);
      }
      set({
        processingKeys: removeMultipleFromSet(processingKeys, keys),
        processingSnapshots: nextSnapshots,
      });
    },

    transferProcessingKey: (oldKey, newKey) => {
      const { processingKeys, processingSnapshots } = get();
      if (!processingKeys.has(oldKey)) return;
      const nextKeys = new Set(processingKeys);
      nextKeys.delete(oldKey);
      nextKeys.add(newKey);
      const nextSnapshots = new Map(processingSnapshots);
      const snapshot = nextSnapshots.get(oldKey);
      nextSnapshots.delete(oldKey);
      nextSnapshots.set(newKey, snapshot);
      set({ processingKeys: nextKeys, processingSnapshots: nextSnapshots });
    },

    // --- Attention keys ---

    addAttentionKey: (key) => {
      set({ attentionKeys: addToSet(get().attentionKeys, key) });
    },

    removeAttentionKey: (key) => {
      set({ attentionKeys: removeFromSet(get().attentionKeys, key) });
    },

    // --- Compound ---

    graduateProcessingKey: (key, hasPendingInteraction) => {
      set((state) => ({
        processingKeys: removeFromSet(state.processingKeys, key),
        processingSnapshots: deleteFromMap(state.processingSnapshots, key),
        attentionKeys: hasPendingInteraction
          ? addToSet(state.attentionKeys, key)
          : state.attentionKeys,
      }));
    },

    // --- Reset ---

    reset: () => {
      set({
        ...INITIAL_STATE,
        processingKeys: new Set(),
        processingSnapshots: new Map(),
        attentionKeys: new Set(),
      });
    },
  })),
);
