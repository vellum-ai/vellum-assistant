/**
 * Conversation ids the document composer (`useDocumentComposerSubmit`) is
 * waiting on an assistant reply for.
 *
 * Kept in a store rather than component state so the "Assistant replied"
 * toast can be raised by an always-mounted watcher
 * (`DocumentComposerReplyWatcher`, mounted in `RootLayout`) instead of a
 * host component that unmounts when the document closes. A document
 * composer send starts the wait; the watcher stops it once the reply
 * arrives.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface DocumentComposerReplyState {
  awaitingReplyConversationIds: ReadonlySet<string>;
}

export interface DocumentComposerReplyActions {
  /** Record that a just-sent document composer message is awaiting a reply. */
  startAwaitingReply: (conversationId: string) => void;
  /** Stop waiting, once the reply toast has fired (or is no longer wanted). */
  stopAwaitingReply: (conversationId: string) => void;
  /** Drop every wait, for a context change that no reply can arrive across. */
  clearAwaitingReplies: () => void;
}

export type DocumentComposerReplyStore = DocumentComposerReplyState &
  DocumentComposerReplyActions;

const useDocumentComposerReplyStoreBase = create<DocumentComposerReplyStore>(
  (set) => ({
    awaitingReplyConversationIds: new Set(),

    startAwaitingReply: (conversationId) => {
      set((s) => {
        const next = new Set(s.awaitingReplyConversationIds);
        next.add(conversationId);
        return { awaitingReplyConversationIds: next };
      });
    },

    stopAwaitingReply: (conversationId) => {
      set((s) => {
        if (!s.awaitingReplyConversationIds.has(conversationId)) {
          return s;
        }
        const next = new Set(s.awaitingReplyConversationIds);
        next.delete(conversationId);
        return { awaitingReplyConversationIds: next };
      });
    },

    clearAwaitingReplies: () => {
      set((s) => {
        if (s.awaitingReplyConversationIds.size === 0) {
          return s;
        }
        return { awaitingReplyConversationIds: new Set() };
      });
    },
  }),
);

export const useDocumentComposerReplyStore = createSelectors(
  useDocumentComposerReplyStoreBase,
);
