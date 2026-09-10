/**
 * Document composer sends (`useDocumentComposerSubmit`) still owed an
 * assistant reply, per conversation and in the order they went out.
 *
 * Kept in a store rather than component state so the "Assistant replied"
 * toast can be raised by an always-mounted watcher
 * (`DocumentComposerReplyWatcher`, mounted in `RootLayout`) instead of a
 * host component that unmounts when the document closes. A send adds itself
 * to its conversation's list before its POST goes out; the daemon's stream
 * then says when it took the send in, and whether it is running or parked in
 * the queue; the watcher settles the sends that are running when a terminal
 * event arrives for that conversation.
 *
 * The store also holds the messages of sends the daemon reported as failed,
 * keyed by the document surface each one was composed for, until that
 * document's composer panel takes its own back, and names the conversations
 * whose last send ended on a handoff, where the processing marker is left up
 * for queued work no send of this store's is in.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import type { DisplayAttachment } from "@/types/attachment-types";
import { createSelectors } from "@/utils/create-selectors";

/** What a send carried, kept so a failure the daemon reports after the
 *  composer was cleared can hand the message back to the document it was
 *  composed for. */
export interface PendingDocumentReplyPayload {
  /** The document surface whose composer the message was written in. */
  surfaceId: string;
  content: string;
  attachments: DisplayAttachment[];
}

export interface PendingDocumentReply {
  /**
   * The `clientMessageId` the send went out with, when known, so stream
   * events that echo it (`message_queued`, `message_queued_deleted`) can be
   * matched to this send rather than to any message in the conversation.
   */
  clientMessageId?: string;
  /**
   * The daemon has taken the send in: it echoed the message back as running,
   * or acked it as queued. Until then nothing on the stream speaks for the
   * send, so a terminal that arrives belongs to some other turn.
   */
  acknowledged: boolean;
  /**
   * The send is parked in the daemon's queue rather than running: some other
   * turn holds the conversation. A terminal never settles a queued send, so
   * it waits for the dequeue that starts its own turn.
   */
  queued: boolean;
  /**
   * The stream's own `message_queued` for this send has arrived. A response
   * can acknowledge a send as queued before its queue event lands, and until
   * that event does, a queue event carrying no nonce is this send's rather
   * than a newer send's.
   */
  queuedOnStream: boolean;
  /**
   * What the send carried, when it was listed with one. The daemon can report
   * a message-scoped failure after the send's own response has already
   * cleared the composer, so the message it took is kept here to hand back.
   */
  payload?: PendingDocumentReplyPayload;
}

export interface DocumentComposerReplyState {
  /**
   * Sends awaiting a reply, keyed by conversation, oldest first. A
   * conversation with nothing pending has no entry.
   */
  pendingReplies: ReadonlyMap<string, readonly PendingDocumentReply[]>;
  /**
   * The messages of failed sends, keyed by the document surface each was
   * composed for, waiting for that document's composer to take one back. A
   * surface holding nothing has no entry.
   */
  failedSends: ReadonlyMap<string, PendingDocumentReplyPayload>;
  /**
   * Conversations whose last send settled on a handoff, so the processing
   * marker stays up for the queued work the handoff announced. A conversation
   * is named until a terminal takes that marker down.
   */
  handedOffConversationIds: ReadonlySet<string>;
}

export interface DocumentComposerReplyActions {
  /**
   * Record that a just-sent document composer message is awaiting a reply.
   * `clientMessageId` is the nonce the send carries, when known; a nonce
   * already listed for the conversation is the same message sent again, and
   * is not listed twice. `payload` is what the send carried, kept for a
   * failure the daemon reports once the composer has moved on.
   */
  startAwaitingReply: (
    conversationId: string,
    clientMessageId?: string,
    payload?: PendingDocumentReplyPayload,
  ) => void;
  /**
   * Drop the send carrying `clientMessageId` from `conversationId`, for a
   * message no reply is coming for. Nothing happens when it is not listed.
   */
  stopAwaitingReply: (conversationId: string, clientMessageId: string) => void;
  /**
   * Drop the send carrying `clientMessageId` from `conversationId` if the
   * daemon has not acknowledged it, for an attempt nothing can retry any
   * more. Reports whether it was dropped. A send the daemon has spoken for
   * stays, since its reply is still coming.
   */
  dropUnacknowledgedReply: (
    conversationId: string,
    clientMessageId: string,
  ) => boolean;
  /**
   * A terminal stream event arrived for `conversationId`: settle every send
   * running there, since one turn answers all of them, and report how many
   * that was. Queued sends stay, as do sends the daemon has not acknowledged
   * yet, and 0 means the terminal belongs to a turn none of these sends is in.
   */
  settleRunningReplies: (conversationId: string) => number;
  /**
   * The daemon echoed the send carrying `clientMessageId` back into
   * `conversationId`: it is running, and the next terminal there is its own.
   * When the event or every pending send lacks a nonce, the oldest send not
   * yet acknowledged is the one echoed; a nonce that names none of them is
   * another client's message.
   */
  markReplyRunning: (conversationId: string, clientMessageId?: string) => void;
  /**
   * The daemon parked the send carrying `clientMessageId` in
   * `conversationId`'s queue, so it is acknowledged but not the one running.
   * When the event or every pending send lacks a nonce, the event is the
   * oldest send's whose response acknowledged it as queued while its own
   * queue event is still to land, else the newest pending send's: on a daemon
   * whose events carry no nonce, a send's queue event can land after the
   * response that acknowledged it, and handing it to a newer send would park
   * one the daemon never queued, while a send whose queue event has landed
   * cannot account for a later one. A nonce that names none of them is
   * another client's message.
   */
  markReplyQueued: (conversationId: string, clientMessageId?: string) => void;
  /**
   * The daemon took the send carrying `clientMessageId` off `conversationId`'s
   * queue for a turn, so it is running now. When the event or every pending
   * send lacks a nonce, the oldest queued send is the one that started; a
   * nonce that names none of them is another client's message.
   */
  clearReplyQueued: (conversationId: string, clientMessageId?: string) => void;
  /**
   * The daemon put the send carrying `clientMessageId` back in
   * `conversationId`'s queue after taking it off for a turn it could not
   * start, so it is queued again. When the event or every pending send lacks a
   * nonce, the send the last dequeue made running is the one put back: the
   * newest send the stream queued and then started. A nonce that names none of
   * them is another client's message.
   */
  markReplyRequeued: (conversationId: string, clientMessageId?: string) => void;
  /**
   * Move the send carrying `clientMessageId` under `conversationId`, and
   * report the conversation it moved from. A send listed under the client key
   * the POST went out with moves under the row the daemon answers on as soon
   * as a stream event names both the nonce and the row, keeping its
   * acknowledged and queued flags and joining the tail of that row's list.
   * Returns null when the nonce is already under `conversationId`, or listed
   * nowhere.
   */
  rekeyReplyByNonce: (
    clientMessageId: string,
    conversationId: string,
  ) => string | null;
  /**
   * The daemon answered the POST for the send carrying `clientMessageId`,
   * queued or running as `queued` says. Stands in for the stream's own
   * acknowledgment only while that has not arrived: the response can reach
   * the client after the stream has already moved the send along, so a send
   * the stream has spoken for is left as the stream put it.
   */
  acknowledgeReply: (
    conversationId: string,
    clientMessageId: string,
    queued: boolean,
  ) => void;
  /**
   * Name `conversationId` as handed off: a handoff settled its running sends
   * with more messages queued behind them, so the marker it left up answers
   * work this store does not list. Naming it twice names it once.
   */
  markHandedOff: (conversationId: string) => void;
  /**
   * Drop `conversationId` from the handed-off conversations, reporting
   * whether it was named. The marker that name stood for is coming down, or
   * a terminal of this store's own sends is taking it down instead.
   */
  clearHandedOff: (conversationId: string) => boolean;
  /**
   * Hold the message of a failed send for the document surface it was
   * composed for, until that document's composer takes it back. A surface
   * already holding one keeps both, oldest first: the two drafts are joined
   * by a blank line and the attachments run one list after the other.
   */
  stashFailedSend: (payload: PendingDocumentReplyPayload) => void;
  /**
   * Take the message held for `surfaceId`, removing it, so one document's
   * composer reclaims only what was composed there. Null when that surface
   * holds none.
   */
  takeFailedSend: (surfaceId: string) => PendingDocumentReplyPayload | null;
  /**
   * Drop every pending send, every held message, and every handed-off
   * conversation, for a context change no reply can arrive across and no
   * composer should carry a message over.
   */
  clearAwaitingReplies: () => void;
}

/**
 * Whether `conversationId` still has document work that keeps its processing
 * marker up: a send waiting on a reply, or queued work a handoff announced,
 * which runs on under the marker the handoff left standing until its own
 * terminal takes it down. Every path that considers taking the marker down
 * asks this, so none of them reports the conversation idle while the other
 * kind of work is still owed.
 */
export function keepsProcessingMarker(
  state: Pick<
    DocumentComposerReplyState,
    "pendingReplies" | "handedOffConversationIds"
  >,
  conversationId: string,
): boolean {
  return (
    state.pendingReplies.has(conversationId) ||
    state.handedOffConversationIds.has(conversationId)
  );
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

/**
 * Two messages held for one surface as a single message, `older` first: the
 * drafts joined by a blank line when both carry text, and the attachments run
 * one list after the other.
 */
function mergeFailedSends(
  older: PendingDocumentReplyPayload,
  newer: PendingDocumentReplyPayload,
): PendingDocumentReplyPayload {
  return {
    surfaceId: older.surfaceId,
    content: [older.content, newer.content]
      .filter((content) => content !== "")
      .join("\n\n"),
    attachments: [...older.attachments, ...newer.attachments],
  };
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
    failedSends: new Map(),
    handedOffConversationIds: new Set(),

    startAwaitingReply: (conversationId, clientMessageId, payload) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId) ?? [];
        if (pending.some((p) => carriesNonce(p, clientMessageId))) {
          return s;
        }
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, [
            ...pending,
            {
              clientMessageId,
              acknowledged: false,
              queued: false,
              queuedOnStream: false,
              payload,
            },
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

    dropUnacknowledgedReply: (conversationId, clientMessageId) => {
      const pending = get().pendingReplies.get(conversationId);
      const index =
        pending?.findIndex((p) => carriesNonce(p, clientMessageId)) ?? -1;
      if (!pending || index === -1 || pending[index].acknowledged) {
        return false;
      }
      set((s) => ({
        pendingReplies: withPending(s.pendingReplies, conversationId, [
          ...pending.slice(0, index),
          ...pending.slice(index + 1),
        ]),
      }));
      return true;
    },

    settleRunningReplies: (conversationId) => {
      const pending = get().pendingReplies.get(conversationId);
      if (!pending) {
        return 0;
      }
      const notRunning = pending.filter((p) => !p.acknowledged || p.queued);
      const settled = pending.length - notRunning.length;
      if (settled === 0) {
        return 0;
      }
      set((s) => ({
        pendingReplies: withPending(
          s.pendingReplies,
          conversationId,
          notRunning,
        ),
      }));
      return settled;
    },

    markReplyRunning: (conversationId, clientMessageId) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId);
        if (!pending || pending.length === 0) {
          return s;
        }
        const index = indexOfAwaitedSend(
          pending,
          clientMessageId,
          pending.findIndex((p) => !p.acknowledged),
        );
        if (index === -1) {
          return s;
        }
        const current = pending[index];
        if (current.acknowledged && !current.queued) {
          return s;
        }
        const next = [...pending];
        next[index] = { ...current, acknowledged: true, queued: false };
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, next),
        };
      });
    },

    markReplyQueued: (conversationId, clientMessageId) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId);
        if (!pending || pending.length === 0) {
          return s;
        }
        const owedQueueEvent = pending.findIndex(
          (p) => p.acknowledged && p.queued && !p.queuedOnStream,
        );
        const index = indexOfAwaitedSend(
          pending,
          clientMessageId,
          owedQueueEvent === -1 ? pending.length - 1 : owedQueueEvent,
        );
        if (index === -1) {
          return s;
        }
        const current = pending[index];
        if (current.queued && current.queuedOnStream) {
          return s;
        }
        const next = [...pending];
        next[index] = {
          ...current,
          acknowledged: true,
          queued: true,
          queuedOnStream: true,
        };
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

    markReplyRequeued: (conversationId, clientMessageId) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId);
        if (!pending || pending.length === 0) {
          return s;
        }
        const index = indexOfAwaitedSend(
          pending,
          clientMessageId,
          pending.findLastIndex(
            (p) => p.acknowledged && !p.queued && p.queuedOnStream,
          ),
        );
        if (index === -1 || pending[index].queued) {
          return s;
        }
        const next = [...pending];
        next[index] = {
          ...pending[index],
          acknowledged: true,
          queued: true,
          queuedOnStream: true,
        };
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, next),
        };
      });
    },

    rekeyReplyByNonce: (clientMessageId, conversationId) => {
      const previous = [...get().pendingReplies].find(
        ([id, pending]) =>
          id !== conversationId &&
          pending.some((p) => carriesNonce(p, clientMessageId)),
      );
      if (!previous) {
        return null;
      }
      const [previousConversationId, previousPending] = previous;
      const index = previousPending.findIndex((p) =>
        carriesNonce(p, clientMessageId),
      );
      const moved = previousPending[index];
      set((s) => {
        const target = s.pendingReplies.get(conversationId) ?? [];
        const listed = target.some((p) => carriesNonce(p, clientMessageId));
        return {
          pendingReplies: withPending(
            withPending(s.pendingReplies, previousConversationId, [
              ...previousPending.slice(0, index),
              ...previousPending.slice(index + 1),
            ]),
            conversationId,
            listed ? target : [...target, moved],
          ),
        };
      });
      return previousConversationId;
    },

    acknowledgeReply: (conversationId, clientMessageId, queued) => {
      set((s) => {
        const pending = s.pendingReplies.get(conversationId);
        if (!pending) {
          return s;
        }
        const index = pending.findIndex((p) =>
          carriesNonce(p, clientMessageId),
        );
        if (index === -1 || pending[index].acknowledged) {
          return s;
        }
        const next = [...pending];
        next[index] = { ...pending[index], acknowledged: true, queued };
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, next),
        };
      });
    },

    markHandedOff: (conversationId) => {
      set((s) => {
        if (s.handedOffConversationIds.has(conversationId)) {
          return s;
        }
        const next = new Set(s.handedOffConversationIds);
        next.add(conversationId);
        return { handedOffConversationIds: next };
      });
    },

    clearHandedOff: (conversationId) => {
      if (!get().handedOffConversationIds.has(conversationId)) {
        return false;
      }
      set((s) => {
        const next = new Set(s.handedOffConversationIds);
        next.delete(conversationId);
        return { handedOffConversationIds: next };
      });
      return true;
    },

    stashFailedSend: (payload) => {
      set((s) => {
        const held = s.failedSends.get(payload.surfaceId);
        const next = new Map(s.failedSends);
        next.set(
          payload.surfaceId,
          held ? mergeFailedSends(held, payload) : payload,
        );
        return { failedSends: next };
      });
    },

    takeFailedSend: (surfaceId) => {
      const held = get().failedSends.get(surfaceId);
      if (held === undefined) {
        return null;
      }
      set((s) => {
        const next = new Map(s.failedSends);
        next.delete(surfaceId);
        return { failedSends: next };
      });
      return held;
    },

    clearAwaitingReplies: () => {
      set((s) => {
        if (
          s.pendingReplies.size === 0 &&
          s.failedSends.size === 0 &&
          s.handedOffConversationIds.size === 0
        ) {
          return s;
        }
        return {
          pendingReplies: new Map(),
          failedSends: new Map(),
          handedOffConversationIds: new Set(),
        };
      });
    },
  }),
);

export const useDocumentComposerReplyStore = createSelectors(
  useDocumentComposerReplyStoreBase,
);
