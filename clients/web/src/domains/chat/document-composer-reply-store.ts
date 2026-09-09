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
  /**
   * Waits whose message the daemon queued behind a turn already running in
   * that conversation. The running turn's own terminal event is not the
   * queued message's, so the watcher lets one such terminal pass before
   * treating the next as the reply.
   */
  queuedReplyConversationIds: ReadonlySet<string>;
  /**
   * The `clientMessageId` each awaited send went out with, so stream events
   * that echo it (`message_queued`, `message_queued_deleted`) can be matched
   * to the awaited message rather than to any message in the conversation.
   */
  awaitingReplyClientMessageIds: ReadonlyMap<string, string>;
}

export interface DocumentComposerReplyActions {
  /**
   * Record that a just-sent document composer message is awaiting a reply.
   * `clientMessageId` is the nonce the send carries, when known.
   */
  startAwaitingReply: (
    conversationId: string,
    clientMessageId?: string,
  ) => void;
  /** Stop waiting, once the reply toast has fired (or is no longer wanted). */
  stopAwaitingReply: (conversationId: string) => void;
  /**
   * Record that the awaited message is queued behind the turn currently
   * running in `conversationId`; starts the wait when none is up yet.
   */
  markReplyQueued: (conversationId: string) => void;
  /** The turn ahead of the queued message has ended; the next terminal is its own. */
  clearReplyQueued: (conversationId: string) => void;
  /** Drop every wait, for a context change that no reply can arrive across. */
  clearAwaitingReplies: () => void;
}

export type DocumentComposerReplyStore = DocumentComposerReplyState &
  DocumentComposerReplyActions;

const useDocumentComposerReplyStoreBase = create<DocumentComposerReplyStore>(
  (set) => ({
    awaitingReplyConversationIds: new Set(),
    queuedReplyConversationIds: new Set(),
    awaitingReplyClientMessageIds: new Map(),

    startAwaitingReply: (conversationId, clientMessageId) => {
      set((s) => {
        const next = new Set(s.awaitingReplyConversationIds);
        next.add(conversationId);
        const nonces = new Map(s.awaitingReplyClientMessageIds);
        if (clientMessageId) {
          nonces.set(conversationId, clientMessageId);
        } else {
          nonces.delete(conversationId);
        }
        return {
          awaitingReplyConversationIds: next,
          awaitingReplyClientMessageIds: nonces,
        };
      });
    },

    stopAwaitingReply: (conversationId) => {
      set((s) => {
        if (!s.awaitingReplyConversationIds.has(conversationId)) {
          return s;
        }
        const next = new Set(s.awaitingReplyConversationIds);
        next.delete(conversationId);
        const queued = new Set(s.queuedReplyConversationIds);
        queued.delete(conversationId);
        const nonces = new Map(s.awaitingReplyClientMessageIds);
        nonces.delete(conversationId);
        return {
          awaitingReplyConversationIds: next,
          queuedReplyConversationIds: queued,
          awaitingReplyClientMessageIds: nonces,
        };
      });
    },

    markReplyQueued: (conversationId) => {
      set((s) => {
        const next = new Set(s.awaitingReplyConversationIds);
        next.add(conversationId);
        const queued = new Set(s.queuedReplyConversationIds);
        queued.add(conversationId);
        return {
          awaitingReplyConversationIds: next,
          queuedReplyConversationIds: queued,
        };
      });
    },

    clearReplyQueued: (conversationId) => {
      set((s) => {
        if (!s.queuedReplyConversationIds.has(conversationId)) {
          return s;
        }
        const queued = new Set(s.queuedReplyConversationIds);
        queued.delete(conversationId);
        return { queuedReplyConversationIds: queued };
      });
    },

    clearAwaitingReplies: () => {
      set((s) => {
        if (
          s.awaitingReplyConversationIds.size === 0 &&
          s.queuedReplyConversationIds.size === 0 &&
          s.awaitingReplyClientMessageIds.size === 0
        ) {
          return s;
        }
        return {
          awaitingReplyConversationIds: new Set(),
          queuedReplyConversationIds: new Set(),
          awaitingReplyClientMessageIds: new Map(),
        };
      });
    },
  }),
);

export const useDocumentComposerReplyStore = createSelectors(
  useDocumentComposerReplyStoreBase,
);
