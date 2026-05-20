/**
 * Zustand store for the client-side slice of the conversation list.
 *
 * Server-derived state (conversations, conversation groups) lives in
 * TanStack Query — see `conversation-list-queries.ts`. This store owns
 * only state that has no server counterpart:
 *
 * - `activeConversationKey` — URL/navigation-local selection
 * - `editingConversationKey` — UI mode (app-edit-chat target)
 * - `processingKeys` — in-flight assistant responses
 * - `attentionKeys` — conversations with pending interactions
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see ./conversation-list-queries.ts for the server-state half
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

// ---------------------------------------------------------------------------
// Set helpers — return the same reference when the mutation is a no-op so
// Zustand's shallow equality check can bail out of unnecessary re-renders.
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

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ConversationListState {
  activeConversationKey: string | null;
  editingConversationKey: string | null;
  processingKeys: Set<string>;
  attentionKeys: Set<string>;
}

export interface ConversationListActions {
  // --- Active / editing key ---
  setActiveKey: (key: string | null) => void;
  setEditingKey: (key: string | null) => void;

  // --- Processing keys ---
  addProcessingKey: (key: string) => void;
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
  attentionKeys: new Set(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConversationListStore = createSelectors(
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

    addProcessingKey: (key) => {
      set({ processingKeys: addToSet(get().processingKeys, key) });
    },

    removeProcessingKey: (key) => {
      set({ processingKeys: removeFromSet(get().processingKeys, key) });
    },

    removeMultipleProcessingKeys: (keys) => {
      set({
        processingKeys: removeMultipleFromSet(get().processingKeys, keys),
      });
    },

    transferProcessingKey: (oldKey, newKey) => {
      const { processingKeys } = get();
      if (!processingKeys.has(oldKey)) return;
      const next = new Set(processingKeys);
      next.delete(oldKey);
      next.add(newKey);
      set({ processingKeys: next });
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
        attentionKeys: hasPendingInteraction
          ? addToSet(state.attentionKeys, key)
          : state.attentionKeys,
      }));
    },

    // --- Reset ---

    reset: () => {
      set({ ...INITIAL_STATE, processingKeys: new Set(), attentionKeys: new Set() });
    },
  })),
);
