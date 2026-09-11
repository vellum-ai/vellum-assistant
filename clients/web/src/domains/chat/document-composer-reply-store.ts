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
 * keyed by the assistant each went to and the document surface it was
 * composed for, until that document's composer panel under that assistant
 * takes its own back, and names the conversations whose last send ended on a
 * handoff, where the processing marker is left up for queued work no send of
 * this store's is in. It keeps, under its nonce, the message of each send an
 * assistant switch cut off before the daemon spoke for it, for that send to
 * hand back if its POST then throws.
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
  /**
   * The assistant the message went to. A teleported copy of an assistant
   * keeps its source's documents, surface ids included, so the surface alone
   * does not say whose composer takes the message back.
   */
  assistantId: string;
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
   * The request ended ambiguously after its composer went away. Its payload
   * is available for recovery, but this nonce stays listed so a later stream
   * acknowledgment can retract that recovery copy.
   */
  recovering?: boolean;
  /**
   * What the send carried, when it was listed with one. The daemon can report
   * a message-scoped failure after the send's own response has already
   * cleared the composer, so the message it took is kept here to hand back.
   */
  payload?: PendingDocumentReplyPayload;
}

interface FailedDocumentSend {
  payload: PendingDocumentReplyPayload;
  /** The ambiguous send this recovery belongs to, until the stream decides
   * whether the assistant accepted it. */
  clientMessageId?: string;
}

interface ClaimedDocumentSendBatch {
  entries: readonly FailedDocumentSend[];
}

export interface ClaimedDocumentSendTransition {
  assistantId: string;
  surfaceId: string;
  before: PendingDocumentReplyPayload;
  after: PendingDocumentReplyPayload | null;
  wasActiveBatch: boolean;
}

/** An accepted send retained while its assistant's event stream is detached. */
export interface DetachedQueuedDocumentSend {
  conversationId: string;
  payload: PendingDocumentReplyPayload;
}

export interface DocumentComposerReplyState {
  /**
   * Sends awaiting a reply, keyed by conversation, oldest first. A
   * conversation with nothing pending has no entry.
   */
  pendingReplies: ReadonlyMap<string, readonly PendingDocumentReply[]>;
  /**
   * The messages of failed sends, keyed by the assistant each went to and the
   * document surface it was composed for (`heldMessageFor` reads one), waiting
   * for that document's composer under that assistant to take one back. A
   * pair holding nothing has no entry.
   */
  failedSends: ReadonlyMap<string, readonly FailedDocumentSend[]>;
  /**
   * Recovery batches already copied into a document composer, keyed by the
   * same assistant-and-surface key as `failedSends`. Entries remain here only
   * while a nonce can still retract accepted content from the shown batch.
   */
  claimedFailedSendBatches: ReadonlyMap<
    string,
    readonly ClaimedDocumentSendBatch[]
  >;
  /** The document composer currently mounted in the shared document slot. */
  activeDocumentComposer: {
    assistantId: string;
    surfaceId: string;
  } | null;
  /**
   * The messages of pending sends an assistant switch cleared before the
   * daemon spoke for them, keyed by the nonce each send went out with. A send
   * whose POST is still out can then throw, and this is the one copy of its
   * message left to hold for its document under its assistant.
   */
  detachedSends: ReadonlyMap<string, PendingDocumentReplyPayload>;
  /**
   * Accepted sends retained across assistant switches, keyed by nonce. When
   * the owner becomes active again, the reply watcher checks the authoritative
   * conversation snapshot while keeping any recovery correlated for a late
   * echo or failure.
   */
  detachedQueuedSends: ReadonlyMap<string, DetachedQueuedDocumentSend>;
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
   * Keep an unacknowledged send correlated after its request ended
   * ambiguously and its composer went away. Reports whether the nonce still
   * names an unacknowledged send.
   */
  markReplyRecovering: (
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
   * Hold the message of a failed send for the assistant it went to and the
   * document surface it was composed for, until that document's composer
   * under that assistant takes it back. A pair already holding one keeps
   * both, oldest first: the two drafts are joined by a blank line and the
   * attachments run one list after the other.
   */
  stashFailedSend: (
    payload: PendingDocumentReplyPayload,
    clientMessageId?: string,
  ) => boolean;
  /** Drop the recovery copy correlated with `clientMessageId`. */
  dropFailedSend: (clientMessageId: string) => boolean;
  /**
   * Resolve a recovery already copied into a composer. The returned before
   * and after payloads let the watcher retract only an unchanged shown batch.
   */
  settleClaimedFailedSend: (
    clientMessageId: string,
  ) => ClaimedDocumentSendTransition | null;
  /**
   * Take the message held for `surfaceId` under `assistantId`, removing it,
   * so one document's composer reclaims only what was composed there for its
   * own assistant. Null when that pair holds none.
   */
  takeFailedSend: (
    assistantId: string,
    surfaceId: string,
  ) => PendingDocumentReplyPayload | null;
  /** Register the document composer that currently owns the shared slot. */
  setActiveDocumentComposer: (
    assistantId: string,
    surfaceId: string,
  ) => void;
  /** Clear the active composer only when it still matches this owner. */
  clearActiveDocumentComposer: (
    assistantId: string,
    surfaceId: string,
  ) => void;
  /**
   * Take the message an assistant switch detached from the send carrying
   * `clientMessageId`, removing it. Null when that send has none detached.
   */
  takeDetachedSend: (
    clientMessageId: string,
  ) => PendingDocumentReplyPayload | null;
  /** Forget an accepted send retained across an assistant switch. */
  dropDetachedQueuedSend: (clientMessageId: string) => boolean;
  /** Keep an accepted send while its assistant stream is detached. */
  recordDetachedQueuedSend: (
    clientMessageId: string,
    conversationId: string,
    payload: PendingDocumentReplyPayload,
  ) => void;
  /**
   * Drop every pending send and every handed-off conversation, for an
   * assistant switch no reply can arrive across. The message of a send the
   * daemon has not spoken for is kept in `detachedSends` under its nonce. An
   * acknowledged send stays in `detachedQueuedSends` until its owner becomes
   * active and the authoritative history says whether it was persisted or
   * remains in flight. Held messages stay, since each is keyed by the assistant
   * it went to as well as its document's surface, and only that document's
   * composer under that assistant takes it back.
   */
  clearAwaitingReplies: () => void;
  /**
   * Drop every held message and every detached one, for leaving every
   * assistant (logout, removing the active assistant), so one user's message
   * never reaches the next context.
   */
  clearHeldMessages: () => void;
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
    state.pendingReplies.get(conversationId)?.some((p) => !p.recovering) ===
      true ||
    state.handedOffConversationIds.has(conversationId)
  );
}

/** The `failedSends` key for `surfaceId` under `assistantId`. No id carries a
 *  NUL, so each pair maps to a key of its own. */
function heldKey(assistantId: string, surfaceId: string): string {
  return `${assistantId}\u0000${surfaceId}`;
}

/**
 * The message held for `surfaceId` under `assistantId`, for that document's
 * composer under that assistant to take back. Undefined when none is held.
 */
export function heldMessageFor(
  state: Pick<DocumentComposerReplyState, "failedSends">,
  assistantId: string,
  surfaceId: string,
): PendingDocumentReplyPayload | undefined {
  const held = state.failedSends.get(heldKey(assistantId, surfaceId));
  return held === undefined
    ? undefined
    : mergeFailedSendList(held);
}

/** The unclaimed recovery copy correlated with `clientMessageId`, if any. */
export function failedDocumentSendForClientMessageId(
  state: Pick<DocumentComposerReplyState, "failedSends">,
  clientMessageId: string,
): PendingDocumentReplyPayload | undefined {
  for (const held of state.failedSends.values()) {
    const match = held.find(
      (entry) => entry.clientMessageId === clientMessageId,
    );
    if (match !== undefined) {
      return match.payload;
    }
  }
  return undefined;
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

/** Remove the transient recovery marker once the stream accepts a send. */
function acceptedReply(
  pending: PendingDocumentReply,
  updates: Pick<PendingDocumentReply, "acknowledged" | "queued"> &
    Partial<Pick<PendingDocumentReply, "queuedOnStream">>,
): PendingDocumentReply {
  const { recovering: _recovering, ...rest } = pending;
  return { ...rest, ...updates };
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
 * Two messages held for one assistant's surface as a single message, `older`
 * first: the drafts joined by a blank line when both carry text, and the
 * attachments run one list after the other.
 */
function mergeFailedSendList(
  entries: readonly FailedDocumentSend[],
): PendingDocumentReplyPayload {
  const cached = mergedFailedSendCache.get(entries);
  if (cached !== undefined) {
    return cached;
  }
  const first = entries[0].payload;
  const merged = {
    assistantId: first.assistantId,
    surfaceId: first.surfaceId,
    content: entries
      .map((entry) => entry.payload.content)
      .filter((content) => content !== "")
      .join("\n\n"),
    attachments: entries.flatMap((entry) => entry.payload.attachments),
  };
  mergedFailedSendCache.set(entries, merged);
  return merged;
}

const mergedFailedSendCache = new WeakMap<
  readonly FailedDocumentSend[],
  PendingDocumentReplyPayload
>();

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
    claimedFailedSendBatches: new Map(),
    activeDocumentComposer: null,
    detachedSends: new Map(),
    detachedQueuedSends: new Map(),
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

    markReplyRecovering: (conversationId, clientMessageId) => {
      const pending = get().pendingReplies.get(conversationId);
      const index =
        pending?.findIndex((p) => carriesNonce(p, clientMessageId)) ?? -1;
      if (!pending || index === -1 || pending[index].acknowledged) {
        return false;
      }
      set((s) => {
        const next = [...pending];
        next[index] = { ...pending[index], recovering: true };
        return {
          pendingReplies: withPending(s.pendingReplies, conversationId, next),
        };
      });
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
        next[index] = acceptedReply(current, {
          acknowledged: true,
          queued: false,
        });
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
        next[index] = acceptedReply(current, {
          acknowledged: true,
          queued: true,
          queuedOnStream: true,
        });
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
        next[index] = acceptedReply(pending[index], {
          acknowledged: true,
          queued: false,
        });
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
        next[index] = acceptedReply(pending[index], {
          acknowledged: true,
          queued: true,
          queuedOnStream: true,
        });
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
        next[index] = acceptedReply(pending[index], {
          acknowledged: true,
          queued,
        });
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

    stashFailedSend: (payload, clientMessageId) => {
      let stashed = false;
      set((s) => {
        const key = heldKey(payload.assistantId, payload.surfaceId);
        const held = s.failedSends.get(key) ?? [];
        if (
          clientMessageId !== undefined &&
          held.some((entry) => entry.clientMessageId === clientMessageId)
        ) {
          return s;
        }
        stashed = true;
        const next = new Map(s.failedSends);
        next.set(key, [...held, { payload, clientMessageId }]);
        return { failedSends: next };
      });
      return stashed;
    },

    dropFailedSend: (clientMessageId) => {
      const match = [...get().failedSends].find(([, held]) =>
        held.some((entry) => entry.clientMessageId === clientMessageId),
      );
      if (!match) {
        return false;
      }
      const [key, held] = match;
      set((s) => {
        const next = new Map(s.failedSends);
        const remaining = held.filter(
          (entry) => entry.clientMessageId !== clientMessageId,
        );
        if (remaining.length === 0) {
          next.delete(key);
        } else {
          next.set(key, remaining);
        }
        return { failedSends: next };
      });
      return true;
    },

    settleClaimedFailedSend: (clientMessageId) => {
      const match = [...get().claimedFailedSendBatches].find(([, batches]) =>
        batches.some((batch) =>
          batch.entries.some(
            (entry) => entry.clientMessageId === clientMessageId,
          ),
        ),
      );
      if (!match) {
        return null;
      }
      const [key, batches] = match;
      const batchIndex = batches.findIndex((batch) =>
        batch.entries.some(
          (entry) => entry.clientMessageId === clientMessageId,
        ),
      );
      const batch = batches[batchIndex];
      const before = mergeFailedSendList(batch.entries);
      const remaining = batch.entries.filter(
        (entry) => entry.clientMessageId !== clientMessageId,
      );
      const after =
        remaining.length === 0 ? null : mergeFailedSendList(remaining);
      const transition: ClaimedDocumentSendTransition = {
        assistantId: before.assistantId,
        surfaceId: before.surfaceId,
        before,
        after,
        wasActiveBatch: batchIndex === batches.length - 1,
      };
      set((s) => {
        const next = new Map(s.claimedFailedSendBatches);
        const nextBatches = [...batches];
        if (remaining.some((entry) => entry.clientMessageId !== undefined)) {
          nextBatches[batchIndex] = { entries: remaining };
        } else {
          nextBatches.splice(batchIndex, 1);
        }
        if (nextBatches.length === 0) {
          next.delete(key);
        } else {
          next.set(key, nextBatches);
        }
        return { claimedFailedSendBatches: next };
      });
      return transition;
    },

    takeFailedSend: (assistantId, surfaceId) => {
      const key = heldKey(assistantId, surfaceId);
      const held = get().failedSends.get(key);
      if (held === undefined) {
        return null;
      }
      set((s) => {
        const next = new Map(s.failedSends);
        next.delete(key);
        if (!held.some((entry) => entry.clientMessageId !== undefined)) {
          return { failedSends: next };
        }
        const claimed = new Map(s.claimedFailedSendBatches);
        const batches = claimed.get(key) ?? [];
        claimed.set(key, [...batches, { entries: held }]);
        return {
          failedSends: next,
          claimedFailedSendBatches: claimed,
        };
      });
      return mergeFailedSendList(held);
    },

    setActiveDocumentComposer: (assistantId, surfaceId) => {
      const active = get().activeDocumentComposer;
      if (
        active?.assistantId === assistantId &&
        active.surfaceId === surfaceId
      ) {
        return;
      }
      set({ activeDocumentComposer: { assistantId, surfaceId } });
    },

    clearActiveDocumentComposer: (assistantId, surfaceId) => {
      const active = get().activeDocumentComposer;
      if (
        active?.assistantId !== assistantId ||
        active.surfaceId !== surfaceId
      ) {
        return;
      }
      set({ activeDocumentComposer: null });
    },

    takeDetachedSend: (clientMessageId) => {
      const detached = get().detachedSends.get(clientMessageId);
      if (detached === undefined) {
        return null;
      }
      set((s) => {
        const next = new Map(s.detachedSends);
        next.delete(clientMessageId);
        return { detachedSends: next };
      });
      return detached;
    },

    dropDetachedQueuedSend: (clientMessageId) => {
      if (!get().detachedQueuedSends.has(clientMessageId)) {
        return false;
      }
      set((s) => {
        const next = new Map(s.detachedQueuedSends);
        next.delete(clientMessageId);
        return { detachedQueuedSends: next };
      });
      return true;
    },

    recordDetachedQueuedSend: (
      clientMessageId,
      conversationId,
      payload,
    ) => {
      set((s) => {
        const next = new Map(s.detachedQueuedSends);
        next.set(clientMessageId, { conversationId, payload });
        return { detachedQueuedSends: next };
      });
    },

    clearAwaitingReplies: () => {
      set((s) => {
        if (
          s.pendingReplies.size === 0 &&
          s.handedOffConversationIds.size === 0
        ) {
          return s;
        }
        const detachedSends = new Map(s.detachedSends);
        const detachedQueuedSends = new Map(s.detachedQueuedSends);
        for (const [conversationId, pending] of s.pendingReplies) {
          for (const p of pending) {
            if (
              !p.acknowledged &&
              !p.recovering &&
              p.clientMessageId &&
              p.payload
            ) {
              detachedSends.set(p.clientMessageId, p.payload);
            }
            if (p.acknowledged && p.clientMessageId && p.payload) {
              detachedQueuedSends.set(p.clientMessageId, {
                conversationId,
                payload: p.payload,
              });
            }
          }
        }
        return {
          pendingReplies: new Map(),
          detachedSends,
          detachedQueuedSends,
          handedOffConversationIds: new Set(),
        };
      });
    },

    clearHeldMessages: () => {
      set((s) => {
        if (
          s.failedSends.size === 0 &&
          s.claimedFailedSendBatches.size === 0 &&
          s.activeDocumentComposer === null &&
          s.detachedSends.size === 0 &&
          s.detachedQueuedSends.size === 0
        ) {
          return s;
        }
        return {
          failedSends: new Map(),
          claimedFailedSendBatches: new Map(),
          activeDocumentComposer: null,
          detachedSends: new Map(),
          detachedQueuedSends: new Map(),
        };
      });
    },
  }),
);

export const useDocumentComposerReplyStore = createSelectors(
  useDocumentComposerReplyStoreBase,
);
