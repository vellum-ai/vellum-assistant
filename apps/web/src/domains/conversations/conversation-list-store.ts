/**
 * Conversation-list state machine.
 *
 * Manages the sidebar / conversation-selection state as a single
 * `useReducer` with typed domain events. All state transitions go through
 * `conversationListReducer`, keeping updates atomic and testable.
 *
 * **State managed:**
 * - `conversations` — the full list of conversations for the sidebar
 * - `conversationGroups` — user-created folder groups
 * - `activeConversationKey` — which conversation is currently open
 * - `editingConversationKey` — which conversation title is being edited
 * - `processingKeys` — conversations with in-flight assistant responses
 * - `attentionKeys` — conversations needing user attention (pending interactions)
 *
 * @see https://react.dev/learn/extracting-state-logic-into-a-reducer
 */

import type { Conversation, ConversationGroup } from "@/domains/chat/lib/api.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** All conversation-list UI state managed by `conversationListReducer`. */
export interface ConversationListState {
  conversations: Conversation[];
  conversationGroups: ConversationGroup[];
  activeConversationKey: string | null;
  editingConversationKey: string | null;
  processingKeys: Set<string>;
  attentionKeys: Set<string>;
}

/** Empty initial state — used as the `useReducer` initializer. */
export const INITIAL_CONVERSATION_LIST_STATE: ConversationListState = {
  conversations: [],
  conversationGroups: [],
  activeConversationKey: null,
  editingConversationKey: null,
  processingKeys: new Set(),
  attentionKeys: new Set(),
};

// ---------------------------------------------------------------------------
// Set helpers — return the same reference when the mutation is a no-op so
// React can bail out of unnecessary re-renders.
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
 * so React can bail out of re-renders.
 */
export function patchConversation(
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

function patchGroup(
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
// Domain events (actions)
// ---------------------------------------------------------------------------

// --- Conversations ---

export interface SetConversations {
  type: "SET_CONVERSATIONS";
  conversations: Conversation[];
}

export interface PatchConversation {
  type: "PATCH_CONVERSATION";
  key: string;
  patch: Partial<Conversation>;
}

export interface MarkConversationSeen {
  type: "MARK_CONVERSATION_SEEN";
  key: string;
  lastSeenAssistantMessageAt?: string;
}

export interface PrependConversation {
  type: "PREPEND_CONVERSATION";
  conversation: Conversation;
}

export interface RemoveConversation {
  type: "REMOVE_CONVERSATION";
  key: string;
}

export interface ResolveDraftKey {
  type: "RESOLVE_DRAFT_KEY";
  oldKey: string;
  newKey: string;
}

// --- Conversation groups ---

export interface SetGroups {
  type: "SET_GROUPS";
  groups: ConversationGroup[];
}

export interface AppendGroup {
  type: "APPEND_GROUP";
  group: ConversationGroup;
}

export interface PatchGroup {
  type: "PATCH_GROUP";
  groupId: string;
  patch: Partial<ConversationGroup>;
}

export interface ReplaceOptimisticGroup {
  type: "REPLACE_OPTIMISTIC_GROUP";
  optimisticId: string;
  group: ConversationGroup;
}

export interface RemoveGroup {
  type: "REMOVE_GROUP";
  groupId: string;
}

export interface DeleteGroupAndResetConversations {
  type: "DELETE_GROUP_AND_RESET_CONVERSATIONS";
  groupId: string;
}

// --- Active / editing key ---

export interface SetActiveKey {
  type: "SET_ACTIVE_KEY";
  key: string | null;
}

export interface SetEditingKey {
  type: "SET_EDITING_KEY";
  key: string | null;
}

// --- Processing keys ---

export interface AddProcessingKey {
  type: "ADD_PROCESSING_KEY";
  key: string;
}

export interface RemoveProcessingKey {
  type: "REMOVE_PROCESSING_KEY";
  key: string;
}

export interface RemoveMultipleProcessingKeys {
  type: "REMOVE_MULTIPLE_PROCESSING_KEYS";
  keys: string[];
}

export interface TransferProcessingKey {
  type: "TRANSFER_PROCESSING_KEY";
  oldKey: string;
  newKey: string;
}

// --- Attention keys ---

export interface AddAttentionKey {
  type: "ADD_ATTENTION_KEY";
  key: string;
}

export interface RemoveAttentionKey {
  type: "REMOVE_ATTENTION_KEY";
  key: string;
}

// --- Compound actions ---

export interface GraduateProcessingKey {
  type: "GRADUATE_PROCESSING_KEY";
  key: string;
  hasPendingInteraction: boolean;
}

export type ConversationListAction =
  | SetConversations
  | PatchConversation
  | MarkConversationSeen
  | PrependConversation
  | RemoveConversation
  | ResolveDraftKey
  | SetGroups
  | AppendGroup
  | PatchGroup
  | ReplaceOptimisticGroup
  | RemoveGroup
  | DeleteGroupAndResetConversations
  | SetActiveKey
  | SetEditingKey
  | AddProcessingKey
  | RemoveProcessingKey
  | RemoveMultipleProcessingKeys
  | TransferProcessingKey
  | AddAttentionKey
  | RemoveAttentionKey
  | GraduateProcessingKey;

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer for conversation-list state.
 *
 * Accepts a `ConversationListAction` discriminated union and returns the
 * next state. Set helpers return the same reference on no-ops so React
 * can bail out of re-renders.
 *
 * Compound actions like `DELETE_GROUP_AND_RESET_CONVERSATIONS` and
 * `GRADUATE_PROCESSING_KEY` update multiple fields atomically.
 */
export function conversationListReducer(
  state: ConversationListState,
  action: ConversationListAction,
): ConversationListState {
  switch (action.type) {
    // ----- Conversations -----

    case "SET_CONVERSATIONS":
      return { ...state, conversations: action.conversations };

    case "PATCH_CONVERSATION":
      return {
        ...state,
        conversations: patchConversation(
          state.conversations,
          action.key,
          action.patch,
        ),
      };

    case "MARK_CONVERSATION_SEEN": {
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.conversationKey !== action.key
            ? c
            : {
                ...c,
                hasUnseenLatestAssistantMessage: false,
                lastSeenAssistantMessageAt:
                  action.lastSeenAssistantMessageAt ??
                  c.latestAssistantMessageAt ??
                  c.lastSeenAssistantMessageAt,
              },
        ),
      };
    }

    case "PREPEND_CONVERSATION":
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
      };

    case "REMOVE_CONVERSATION":
      return {
        ...state,
        conversations: state.conversations.filter(
          (c) => c.conversationKey !== action.key,
        ),
      };

    case "RESOLVE_DRAFT_KEY":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.conversationKey === action.oldKey
            ? { ...c, conversationKey: action.newKey, draft: false }
            : c,
        ),
      };

    // ----- Conversation groups -----

    case "SET_GROUPS":
      return { ...state, conversationGroups: action.groups };

    case "APPEND_GROUP":
      return {
        ...state,
        conversationGroups: [
          ...state.conversationGroups,
          {
            ...action.group,
            sortPosition: action.group.sortPosition || state.conversationGroups.length,
          },
        ],
      };

    case "PATCH_GROUP":
      return {
        ...state,
        conversationGroups: patchGroup(
          state.conversationGroups,
          action.groupId,
          action.patch,
        ),
      };

    case "REPLACE_OPTIMISTIC_GROUP":
      return {
        ...state,
        conversationGroups: state.conversationGroups.map((g) =>
          g.id === action.optimisticId ? action.group : g,
        ),
      };

    case "REMOVE_GROUP":
      return {
        ...state,
        conversationGroups: state.conversationGroups.filter(
          (g) => g.id !== action.groupId,
        ),
      };

    case "DELETE_GROUP_AND_RESET_CONVERSATIONS":
      return {
        ...state,
        conversationGroups: state.conversationGroups.filter(
          (g) => g.id !== action.groupId,
        ),
        conversations: state.conversations.map((c) =>
          c.groupId === action.groupId ? { ...c, groupId: undefined } : c,
        ),
      };

    // ----- Active / editing key -----

    case "SET_ACTIVE_KEY":
      return { ...state, activeConversationKey: action.key };

    case "SET_EDITING_KEY":
      return { ...state, editingConversationKey: action.key };

    // ----- Processing keys -----

    case "ADD_PROCESSING_KEY":
      return {
        ...state,
        processingKeys: addToSet(state.processingKeys, action.key),
      };

    case "REMOVE_PROCESSING_KEY":
      return {
        ...state,
        processingKeys: removeFromSet(state.processingKeys, action.key),
      };

    case "REMOVE_MULTIPLE_PROCESSING_KEYS":
      return {
        ...state,
        processingKeys: removeMultipleFromSet(
          state.processingKeys,
          action.keys,
        ),
      };

    case "TRANSFER_PROCESSING_KEY": {
      if (!state.processingKeys.has(action.oldKey)) return state;
      const next = new Set(state.processingKeys);
      next.delete(action.oldKey);
      next.add(action.newKey);
      return { ...state, processingKeys: next };
    }

    // ----- Attention keys -----

    case "ADD_ATTENTION_KEY":
      return {
        ...state,
        attentionKeys: addToSet(state.attentionKeys, action.key),
      };

    case "REMOVE_ATTENTION_KEY":
      return {
        ...state,
        attentionKeys: removeFromSet(state.attentionKeys, action.key),
      };

    // ----- Compound -----

    case "GRADUATE_PROCESSING_KEY":
      return {
        ...state,
        processingKeys: removeFromSet(state.processingKeys, action.key),
        attentionKeys: action.hasPendingInteraction
          ? addToSet(state.attentionKeys, action.key)
          : state.attentionKeys,
      };

    default:
      return state;
  }
}
