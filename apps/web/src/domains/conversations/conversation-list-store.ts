/**
 * Zustand store for conversation-list state.
 *
 * Manages the sidebar / conversation-selection state with direct named
 * actions. Each action calls `set()` to apply pure transitions so UI
 * components can derive display state deterministically.
 *
 * **State managed:**
 * - `conversations` — the full list of conversations for the sidebar
 * - `conversationGroups` — user-created folder groups
 * - `activeConversationKey` — which conversation is currently open
 * - `editingConversationKey` — which conversation title is being edited
 * - `processingKeys` — conversations with in-flight assistant responses
 * - `attentionKeys` — conversations needing user attention (pending interactions)
 *
 * @see https://zustand.docs.pmnd.rs/guides/flux-inspired-practice
 * @see https://zustand.docs.pmnd.rs/guides/updating-state
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import type { Conversation, ConversationGroup } from "@/domains/chat/api/conversations.js";

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
// Conversation helpers
// ---------------------------------------------------------------------------

/**
 * Immutably patch the conversation matching `key`, leaving all others
 * untouched. Returns the same array reference when no conversation matches
 * so Zustand can bail out of re-renders.
 */
export function applyConversationPatch(
  conversations: Conversation[],
  key: string,
  patch: Partial<Conversation>,
): Conversation[] {
  let changed = false;
  const result = conversations.map((c) => {
    if (c.conversationKey !== key) return c;
    changed = true;
    return { ...c, ...patch };
  });
  return changed ? result : conversations;
}

function applyGroupPatch(
  groups: ConversationGroup[],
  id: string,
  patch: Partial<ConversationGroup>,
): ConversationGroup[] {
  let changed = false;
  const result = groups.map((g) => {
    if (g.id !== id) return g;
    changed = true;
    return { ...g, ...patch };
  });
  return changed ? result : groups;
}

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface ConversationListState {
  conversations: Conversation[];
  conversationGroups: ConversationGroup[];
  activeConversationKey: string | null;
  editingConversationKey: string | null;
  processingKeys: Set<string>;
  /**
   * Per-conversation snapshot of `latestAssistantMessageAt` at the moment the
   * key was added to `processingKeys`. The attention-tracking graduation logic
   * compares the current `latestAssistantMessageAt` against this snapshot to
   * detect when the assistant has finished responding. Entries are added by
   * `addProcessingKey` and cleared by every action that removes from
   * `processingKeys`, so the two collections stay in sync.
   */
  processingSnapshots: Map<string, string | undefined>;
  attentionKeys: Set<string>;
}

export interface ConversationListActions {
  // --- Conversations ---
  setConversations: (conversations: Conversation[]) => void;
  patchConversation: (key: string, patch: Partial<Conversation>) => void;
  markConversationSeen: (key: string, lastSeenAssistantMessageAt?: string) => void;
  prependConversation: (conversation: Conversation) => void;
  removeConversation: (key: string) => void;
  resolveDraftKey: (oldKey: string, newKey: string) => void;

  // --- Conversation groups ---
  setGroups: (groups: ConversationGroup[]) => void;
  appendGroup: (group: ConversationGroup) => void;
  patchGroup: (groupId: string, patch: Partial<ConversationGroup>) => void;
  replaceOptimisticGroup: (optimisticId: string, group: ConversationGroup) => void;
  removeGroup: (groupId: string) => void;
  deleteGroupAndResetConversations: (groupId: string) => void;

  // --- Active / editing key ---
  setActiveKey: (key: string | null) => void;
  setEditingKey: (key: string | null) => void;

  // --- Processing keys ---
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
  conversations: [],
  conversationGroups: [],
  activeConversationKey: null,
  editingConversationKey: null,
  processingKeys: new Set(),
  processingSnapshots: new Map(),
  attentionKeys: new Set(),
};

/**
 * Return a new Map with the given key removed, or the same reference if the
 * key wasn't present — lets Zustand's shallow equality bail out of
 * unnecessary re-renders.
 */
function deleteFromMap<K, V>(prev: Map<K, V>, key: K): Map<K, V> {
  if (!prev.has(key)) return prev;
  const next = new Map(prev);
  next.delete(key);
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useConversationListStore = createSelectors(
  create<ConversationListStore>((set, get) => ({
    ...INITIAL_STATE,

    // --- Conversations ---

    setConversations: (conversations) => {
      set({ conversations });
    },

    patchConversation: (key, patch) => {
      set({ conversations: applyConversationPatch(get().conversations, key, patch) });
    },

    markConversationSeen: (key, lastSeenAssistantMessageAt) => {
      set({
        conversations: get().conversations.map((c) =>
          c.conversationKey !== key
            ? c
            : {
                ...c,
                hasUnseenLatestAssistantMessage: false,
                lastSeenAssistantMessageAt:
                  lastSeenAssistantMessageAt ??
                  c.latestAssistantMessageAt ??
                  c.lastSeenAssistantMessageAt,
              },
        ),
      });
    },

    prependConversation: (conversation) => {
      set({ conversations: [conversation, ...get().conversations] });
    },

    removeConversation: (key) => {
      set({
        conversations: get().conversations.filter(
          (c) => c.conversationKey !== key,
        ),
      });
    },

    resolveDraftKey: (oldKey, newKey) => {
      set({
        conversations: get().conversations.map((c) =>
          c.conversationKey === oldKey
            ? { ...c, conversationKey: newKey, draft: false }
            : c,
        ),
      });
    },

    // --- Conversation groups ---

    setGroups: (groups) => {
      set({ conversationGroups: groups });
    },

    appendGroup: (group) => {
      set({
        conversationGroups: [
          ...get().conversationGroups,
          {
            ...group,
            sortPosition: group.sortPosition || get().conversationGroups.length,
          },
        ],
      });
    },

    patchGroup: (groupId, patch) => {
      set({
        conversationGroups: applyGroupPatch(
          get().conversationGroups,
          groupId,
          patch,
        ),
      });
    },

    replaceOptimisticGroup: (optimisticId, group) => {
      set({
        conversationGroups: get().conversationGroups.map((g) =>
          g.id === optimisticId ? group : g,
        ),
      });
    },

    removeGroup: (groupId) => {
      set({
        conversationGroups: get().conversationGroups.filter(
          (g) => g.id !== groupId,
        ),
      });
    },

    deleteGroupAndResetConversations: (groupId) => {
      set({
        conversationGroups: get().conversationGroups.filter(
          (g) => g.id !== groupId,
        ),
        conversations: get().conversations.map((c) =>
          c.groupId === groupId ? { ...c, groupId: undefined } : c,
        ),
      });
    },

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
