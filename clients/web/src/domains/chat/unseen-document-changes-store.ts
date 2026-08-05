/**
 * Documents the assistant changed since the user last looked at them.
 *
 * Session-ephemeral: the flag lives only for the life of the tab, so a reload
 * starts clean. There is no server-side "unseen" record to reconcile against.
 *
 * Entries are keyed by conversation so a change in a background conversation
 * cannot light the affordance on the conversation currently on screen.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface UnseenDocumentChangesState {
  /**
   * Conversation id to the surface ids of its documents with unseen changes.
   *
   * A conversation with nothing unseen carries no entry at all, so an empty
   * set is never left behind for a predicate to have to interpret.
   */
  changedDocuments: Record<string, ReadonlySet<string>>;
}

export interface UnseenDocumentChangesActions {
  /** Record that a document changed while the user was not looking at it. */
  markDocumentChanged: (conversationId: string, surfaceId: string) => void;
  /** Clear one document, for "the user opened that document". */
  clearDocument: (conversationId: string, surfaceId: string) => void;
  /** Clear a whole conversation, for "the user opened the assets sheet". */
  clearConversation: (conversationId: string) => void;
}

export type UnseenDocumentChangesStore = UnseenDocumentChangesState &
  UnseenDocumentChangesActions;

const useUnseenDocumentChangesStoreBase = create<UnseenDocumentChangesStore>()(
  (set) => ({
    changedDocuments: {},

    markDocumentChanged: (conversationId, surfaceId) => {
      set((s) => {
        const current = s.changedDocuments[conversationId];
        if (current?.has(surfaceId)) {
          return s;
        }
        const next = new Set(current);
        next.add(surfaceId);
        return {
          changedDocuments: { ...s.changedDocuments, [conversationId]: next },
        };
      });
    },

    clearDocument: (conversationId, surfaceId) => {
      set((s) => {
        const current = s.changedDocuments[conversationId];
        if (!current?.has(surfaceId)) {
          return s;
        }
        const next = new Set(current);
        next.delete(surfaceId);
        const changedDocuments = { ...s.changedDocuments };
        if (next.size === 0) {
          delete changedDocuments[conversationId];
        } else {
          changedDocuments[conversationId] = next;
        }
        return { changedDocuments };
      });
    },

    clearConversation: (conversationId) => {
      set((s) => {
        if (s.changedDocuments[conversationId] === undefined) {
          return s;
        }
        const changedDocuments = { ...s.changedDocuments };
        delete changedDocuments[conversationId];
        return { changedDocuments };
      });
    },
  }),
);

export const useUnseenDocumentChangesStore = createSelectors(
  useUnseenDocumentChangesStoreBase,
);

/**
 * Whether a conversation has any document changed since the user last looked.
 *
 * Pure predicate so the reactive affordance and the imperative clearing paths
 * can never disagree about what "unseen" means. Takes the store state, so an
 * event handler can pass `useUnseenDocumentChangesStore.getState()` directly.
 */
export function hasUnseenChanges(
  state: UnseenDocumentChangesState,
  conversationId: string | null,
): boolean {
  if (conversationId === null) {
    return false;
  }
  return (state.changedDocuments[conversationId]?.size ?? 0) > 0;
}

/**
 * Reactive form of {@link hasUnseenChanges}, composed over the atomic selector
 * so a consumer only re-renders when the unseen map changes.
 */
export function useHasUnseenDocumentChanges(
  conversationId: string | null,
): boolean {
  const changedDocuments = useUnseenDocumentChangesStore.use.changedDocuments();
  return hasUnseenChanges({ changedDocuments }, conversationId);
}
