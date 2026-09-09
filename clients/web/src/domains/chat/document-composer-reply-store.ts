/**
 * Document composer sends (`useDocumentComposerSubmit`) still owed an
 * assistant reply, per conversation and in the order they went out.
 *
 * Kept in a store rather than component state so the "Assistant replied"
 * toast can be raised by an always-mounted watcher
 * (`DocumentComposerReplyWatcher`, mounted in `RootLayout`) instead of a
 * host component that unmounts when the document closes. A send adds itself
 * to its conversation's list; the watcher settles the sends that are running
 * when a terminal stream event arrives for that conversation. The daemon's
 * queue events say which sends those are.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface PendingDocumentReply {
  /**
   * The `clientMessageId` the send went out with, when known, so stream
   * events that echo it (`message_queued`, `message_queued_deleted`) can be
   * matched to this send rather than to any message in the conversation.
   */
  clientMessageId?: string;
  /**
   * The send is parked in the daemon's queue rather than running: some other
   * turn holds the conversation. A terminal never settles a queued send, so
   * it waits for the dequeue that starts its own turn.
   */
  queued: boolean;
}

export interface DocumentComposerReplyState {
  /**
   * Sends awaiting a reply, keyed by conversation, oldest first. A
   * conversation with nothing pending has no entry.
   */
  pendingReplies: ReadonlyMap<string, readonly PendingDocumentReply[]>;
}

export interface DocumentComposerReplyActions {
  /**
   * Record that a just-sent document composer message is awaiting a reply.
   * `clientMessageId` is the nonce the send carries, when known; a nonce
   * already listed for the conversation is the same message sent again, and
   * is not listed twice.
   */
  startAwaitingReply: (
    conversationId: string,
    clientMessageId?: string,
  ) => void;
  /**
   * Drop the send carrying `clientMessageId` from `conversationId`, for a
   * message no reply is coming for. Nothing happens when it is not listed.
   */
  stopAwaitingReply: (conversationId: string, clientMessageId: string) => void;
  /**
   * A terminal stream event arrived for `conversationId`: settle every send
   * running there, since one turn answers all of them, and report how many
   * that was. Queued sends stay, and 0 means the terminal belongs to a turn
   * none of these sends is in.
   */
  settleRunningReplies: (conversationId: string) => number;
  /**
   * The daemon parked the send carrying `clientMessageId` in
   * `conversationId`'s queue, so it is not the one running. When the event or
   * every pending send lacks a nonce, the newest pending send is the one that
   * was queued; a nonce that names none of them is another client's message.
   */
  markReplyQueued: (conversationId: string, clientMessageId?: string) => void;
  /**
   * The daemon took the send carrying `clientMessageId` off `conversationId`'s
   * queue for a turn, so it is running now. When the event or every pending
   * send lacks a nonce, the oldest queued send is the one that started; a
   * nonce that names none of them is another client's message.
   */
  clearReplyQueued: (conversationId: string, clientMessageId?: string) => void;
  /** Drop every pending send, for a context change no reply can arrive across. */
  clearAwaitingReplies: () => void;
}

export type DocumentComposerReplyStore = DocumentComposerReplyState &
  DocumentComposerReplyActions;

/** Whether `clientMessageId` names the send in `pending`, or no send at all. */
function carriesNonce(
  pending: PendingDocumentReply,
  clientMessageId: string | undefined,
): boolean {
  return clientMessageId !== undefined
    ? pending.clientMessageId === clientMessageId
    : false;
}

/**
 * The index of the send a queue event speaks for: the one carrying the
 * event's nonce, else `fallback` when nonces cannot decide it (the event or
 * every pending send has none), else -1 for another client's message.
 */
function indexOfAwaitedSend(
  pending: readonly PendingDocumentReply[],
  clientMessageId: string | undefined,
  fallback: number,
): number {
  const index = pending.findIndex((p) => carriesNonce(p, clientMessageId));
  if (index !== -1) {
    return index;
  }
  const noncesDecide =
    clientMessageId !== undefined &&
    pending.some((p) => p.clientMessageId !== undefined);
  return noncesDecide ? -1 : fallback;
}

/** The map with `conversationId`'s list replaced, or removed when empty. */
function withPending(
  map: ReadonlyMap<string, readonly PendingDocumentReply[]>,
  conversationId: string,
  pending: readonly PendingDocumentReply[],
): ReadonlyMap<string, readonly PendingDocumentReply[]> {
  const next = new Map(map);
  if (pending.length === 0) {
    next.delete(conversationId);
  } else {
    next.set(conversationId, pending);
  }
  return next;
}

const useDocumentComposerReplyStoreBase = create<DocumentComposerReplyStore>(
  (set, get) => ({
    pendingReplies: new Map(),

    startAwaitingReply: (conversationId, clientMessageId) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId) ?? [];
        if (pending.some((p) => carriesNonce(p, clientMessageId))) {
          return s;
        }
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, [
            ...pending,
            { clientMessageId, queued: false },
          ]),
        };
      });
    },

    stopAwaitingReply: (conversationId, clientMessageId) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId);
        if (!pending) {
          return s;
        }
        const index = pending.findIndex((p) =>
          carriesNonce(p, clientMessageId),
        );
        if (index === -1) {
          return s;
        }
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, [
            ...pending.slice(0, index),
            ...pending.slice(index + 1),
          ]),
        };
      });
    },

    settleRunningReplies: (conversationId) => {
      const pending = get().pendingReplies.get(conversationId);
      if (!pending) {
        return 0;
      }
      const stillQueued = pending.filter((p) => p.queued);
      const settled = pending.length - stillQueued.length;
      if (settled === 0) {
        return 0;
      }
      set((s) => ({
        pendingReplies: withPending(
          s.pendingReplies,
          conversationId,
          stillQueued,
        ),
      }));
      return settled;
    },

    markReplyQueued: (conversationId, clientMessageId) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId);
        if (!pending || pending.length === 0) {
          return s;
        }
        const index = indexOfAwaitedSend(
          pending,
          clientMessageId,
          pending.length - 1,
        );
        if (index === -1 || pending[index].queued) {
          return s;
        }
        const next = [...pending];
        next[index] = { ...pending[index], queued: true };
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, next),
        };
      });
    },

    clearReplyQueued: (conversationId, clientMessageId) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId);
        if (!pending || pending.length === 0) {
          return s;
        }
        const index = indexOfAwaitedSend(
          pending,
          clientMessageId,
          pending.findIndex((p) => p.queued),
        );
        if (index === -1 || !pending[index].queued) {
          return s;
        }
        const next = [...pending];
        next[index] = { ...pending[index], queued: false };
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, next),
        };
      });
    },

    clearAwaitingReplies: () => {
      set((s) => {
        if (s.pendingReplies.size === 0) {
          return s;
        }
        return { pendingReplies: new Map() };
      });
    },
  }),
);

export const useDocumentComposerReplyStore = createSelectors(
  useDocumentComposerReplyStoreBase,
);
