/**
 * End-of-turn finalize work that runs after the terminal SSE.
 *
 * The web/Capacitor/CLI clients re-enable the composer the moment they observe
 * the terminal `message_complete` / `assistant_activity_state("idle")` SSE, so
 * any awaited work between the last streamed token and that emission is what the
 * user perceives as the "still spinning after the reply finished" gap.
 *
 * None of the work here gates delivery of the reply: memory/attention indexing
 * only feeds the NEXT turn's retrieval and a sidebar indicator, tool-result
 * truncation only reshapes the in-memory history the next turn is built from,
 * and the disk-view mirror is a durability convenience. The work is split by
 * whether a step is safe to overlap the NEXT turn:
 *
 * - {@link settleTurnContent} runs while the turn still holds the processing
 *   lock. Its steps rewrite `ctx.messages` and append to the conversation's disk
 *   view, both of which the next turn also writes, so they must finish before
 *   the lock releases. Every step is synchronous apart from the stranded-content
 *   fold, so holding the lock across them costs the queue nothing: synchronous
 *   work blocks the event loop either way.
 * - {@link runDeferredTurnTail} runs detached, after the lock releases, chained
 *   by `chainTurnTail` so two turns' tails never overlap each other. Its steps
 *   are keyed by the message ids this turn produced and are network-bound
 *   (embeddings, vector upserts, the assistant-reply push notification), which
 *   is the work that must not hold the lock:
 *   a slow index otherwise leaves the next send queued behind an idle-looking UI.
 */

import type pino from "pino";

import { getConfig } from "../config/loader.js";
import {
  derefToolResultReReads,
  postTurnTruncateToolResults,
} from "../context/post-turn-tool-result-truncation.js";
import { emitAssistantReplyNotification } from "../notifications/assistant-reply-producer.js";
import { projectAssistantMessage } from "../persistence/conversation-attention-store.js";
import {
  type ConversationRow,
  getConversation,
  getMessageById,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import { getResolvedConversationDirPath } from "../persistence/conversation-directories.js";
import { syncMessageToDisk } from "../persistence/conversation-disk-view.js";
import { enqueueLexicalIndexForMessage } from "../persistence/job-handlers/message-lexical.js";
import { indexMessageNow } from "../plugins/defaults/memory/indexer.js";
import type { Message } from "../providers/types.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import {
  finalizeStrandedInflightContent,
  type InflightContentWriter,
} from "./inflight-message-content.js";
import { conversationMetadataSyncTag } from "./message-types/sync.js";

/** Minimal live-conversation surface the finalize steps read and rewrite. */
interface TurnTailContext {
  readonly conversationId: string;
  messages: Message[];
}

/** Minimal per-run handler state {@link settleTurnContent} consumes. */
interface TurnContentState {
  readonly lastAssistantMessageId: string | undefined;
  /** In-flight content writers the turn left behind (see EventHandlerState). */
  readonly inflightWriters: Map<string, InflightContentWriter>;
}

/** Minimal per-run handler state the detached tail consumes. */
interface TurnTailState {
  readonly deferredFinalizeEffects: ReadonlyArray<() => Promise<void>>;
  readonly lastAssistantMessageId: string | undefined;
}

/**
 * Build the deferred finalize side-effect for one finalized assistant row:
 * memory segment indexing, lexical indexing, and attention projection.
 *
 * `reserveMessage` + `updateMessageContent` are CRUD-only — unlike `addMessage`,
 * they don't run the memory indexer or the attention-cursor projector as insert
 * side-effects — so the assistant row's external state (Qdrant segments,
 * attention cursor) is brought into lockstep with the finalized content here.
 * The returned closure captures the row id and its already-persisted content
 * JSON, and is drained by {@link runDeferredTurnTail} after the terminal SSE.
 * Each step is best-effort: a memory hiccup must not escalate a delivered reply
 * into a turn-level throw.
 */
export function buildDeferredFinalizeEffect(params: {
  conversationId: string;
  assistantMessageId: string;
  contentJson: string;
  rlog: pino.Logger;
}): () => Promise<void> {
  const { conversationId, assistantMessageId, contentJson, rlog } = params;
  return async () => {
    const finalizedRow = getMessageById(assistantMessageId, conversationId);
    if (!finalizedRow) {
      return;
    }
    // Provenance/automation flags for the memory write-gate come off the
    // persisted metadata via the shared `parseMessageMetadata` (the single
    // source of truth for its shape) rather than a hand-copied union.
    const metadata = parseMessageMetadata(finalizedRow.metadata);
    try {
      await indexMessageNow(
        {
          messageId: assistantMessageId,
          conversationId,
          role: "assistant",
          content: contentJson,
          createdAt: finalizedRow.createdAt,
          provenanceTrustClass: metadata?.provenanceTrustClass,
          automated: metadata?.automated,
        },
        getConfig().memory,
      );
    } catch (err) {
      rlog.warn(
        { err, conversationId, messageId: assistantMessageId },
        "Failed to index assistant message for memory (non-fatal)",
      );
    }
    // Dual-write the finalized assistant content into the lexical index. The
    // reserve+finalize path bypasses the `addMessage` persist path, so enqueue
    // here to keep the lexical index in lockstep with the segment index.
    enqueueLexicalIndexForMessage(assistantMessageId);
    try {
      const attentionStateChanged = projectAssistantMessage({
        conversationId,
        messageId: assistantMessageId,
        messageAt: finalizedRow.createdAt,
      });
      if (attentionStateChanged) {
        void publishSyncInvalidation([
          conversationMetadataSyncTag(conversationId),
        ]);
      }
    } catch (err) {
      rlog.warn(
        { err, conversationId, messageId: assistantMessageId },
        "Failed to project assistant message for attention tracking (non-fatal)",
      );
    }
  };
}

/**
 * Settle the turn's content while the processing lock is still held.
 *
 * These steps run after the terminal SSE (so they are off the last-token to
 * composer-enabled path) but before the lock releases, because each one writes
 * a resource the next turn also writes: the in-memory history array and the
 * conversation's append-only disk view. The processing lock is the only
 * per-conversation serialization those resources have, so letting these steps
 * run past the release would let a fast follow-up turn interleave with them.
 * Every step is best-effort.
 */
export async function settleTurnContent(params: {
  ctx: TurnTailContext;
  state: TurnContentState;
  rlog: pino.Logger;
}): Promise<void> {
  const { ctx, state, rlog } = params;

  // Conversation row for the two filesystem steps below. Read here rather than
  // reused from anywhere earlier in the turn: the turn is long enough for the
  // user to delete the conversation, and a row read before that deletion stays
  // truthy across it, so spooling or mirroring against it would rebuild a
  // deleted conversation's directory from in-memory history. A row that is gone
  // skips both steps exactly as an unreadable one does. Guarded like every step
  // below, because this runs after the terminal SSE and a SQLite hiccup must not
  // escape into the loop's outer catch.
  let liveConversation: ConversationRow | null = null;
  try {
    liveConversation = getConversation(ctx.conversationId);
  } catch (err) {
    rlog.warn({ err }, "Failed to read conversation for end-of-turn work");
  }

  // Post-turn tool-result truncation: spool oversized results to disk and
  // replace their in-context content with a stub + pointer, shrinking the next
  // turn's context. Rewrites only the in-memory history, so it has no bearing on
  // the reply already delivered to the client.
  try {
    if (liveConversation) {
      const convDir = getResolvedConversationDirPath(
        ctx.conversationId,
        liveConversation.createdAt,
      );
      const { messages: derefMessages, dereferencedCount } =
        derefToolResultReReads(ctx.messages);
      const { messages: truncatedMessages, truncatedCount } =
        postTurnTruncateToolResults(derefMessages, {
          conversationDir: convDir,
        });
      if (truncatedCount > 0 || dereferencedCount > 0) {
        rlog.info(
          { truncatedCount, dereferencedCount },
          "Post-turn tool result truncation applied",
        );
      }
      ctx.messages = truncatedMessages;
    }
  } catch (err) {
    rlog.warn({ err }, "Post-turn tool result truncation failed (non-fatal)");
  }

  // Fold any in-flight content writers the turn left behind (cancelled or
  // aborted turns exit before their rows' finalize seams). Guarded like the
  // steps below: a failure must not escape past the terminal SSE.
  try {
    await finalizeStrandedInflightContent(state.inflightWriters, rlog);
  } catch (err) {
    rlog.warn(
      { err },
      "Failed to finalize stranded in-flight content (non-fatal)",
    );
  }

  // Mirror the final assistant row into the JSONL disk view. Guarded like the
  // steps above: this runs AFTER the terminal SSE, so a throw here must not
  // escape into the loop's outer catch and emit a second, contradictory
  // terminal event for a turn the client already saw complete.
  try {
    if (state.lastAssistantMessageId && liveConversation) {
      syncMessageToDisk(
        ctx.conversationId,
        state.lastAssistantMessageId,
        liveConversation.createdAt,
      );
    }
  } catch (err) {
    rlog.warn({ err }, "Failed to sync assistant message to disk (non-fatal)");
  }
}

/**
 * Drain a turn's deferred bookkeeping after the processing lock has released.
 *
 * Runs detached from the agent loop and chained through `chainTurnTail`, so a
 * slow index never holds the next turn's send behind an idle composer, yet two
 * turns' tails still run in turn order even when the second turn ran on a
 * rebuilt `Conversation` instance. Every step is best-effort and keyed by a
 * message id this turn produced, so it neither reads nor writes state the next
 * turn owns.
 *
 * `criticalSectionMs` is the lock-held window the agent loop measured from the
 * end of generation; paired with `deferredTailMs` it splits the end-of-turn
 * window into the part a waiting sender feels and the part it no longer does.
 */
export async function runDeferredTurnTail(params: {
  conversationId: string;
  state: TurnTailState;
  rlog: pino.Logger;
  criticalSectionMs: number;
  /**
   * True only for a `message_complete` turn that produced a genuine reply. A
   * handed-off generation is not the end of the run, a cancelled one has no
   * final reply, and a provider-error turn's only assistant row is the
   * synthetic error text.
   */
  turnCompleted: boolean;
  /** Id of the row that opened this turn, for the notification producer. */
  userMessageId: string | undefined;
  /**
   * True when this turn's reply streams to the app and nowhere else, for the
   * notification producer's delivery-surface gates.
   */
  replyDeliveredInAppOnly?: boolean;
}): Promise<void> {
  const {
    conversationId,
    state,
    rlog,
    criticalSectionMs,
    turnCompleted,
    userMessageId,
    replyDeliveredInAppOnly,
  } = params;
  const tailStartedAt = Date.now();

  // Conversation row for the notification producer below. Guarded like every
  // step here, because this runs after the terminal SSE and a SQLite hiccup must
  // not escape into the detached tail's caller.
  let conversation: ConversationRow | null = null;
  try {
    conversation = getConversation(conversationId);
  } catch (err) {
    rlog.warn({ err }, "Failed to read conversation for end-of-turn work");
  }

  // Per-message memory/attention finalize side-effects deferred from
  // `handleMessageComplete`: one closure per assistant row produced this turn,
  // in production order.
  for (const effect of state.deferredFinalizeEffects) {
    try {
      await effect();
    } catch (err) {
      rlog.warn({ err }, "Deferred finalize side-effect failed (non-fatal)");
    }
  }

  // Notify about a finished reply the user is no longer looking at. Ordered
  // after the loop above so the producer's unseen check reads the attention
  // cursor this turn's last row just projected; that projection is the
  // network-bound work this whole tail exists to keep off the lock, so the
  // check necessarily runs with the conversation already free. A follow-up
  // send that beats it there advances the cursor and suppresses the push,
  // which is the right answer: a user typing the next message is looking at
  // the reply. Not awaited: the pipeline awaits the platform adapter's HTTP
  // dispatch, which retries with backoff, and nothing below here depends on
  // the emit. The producer never rejects.
  if (turnCompleted && state.lastAssistantMessageId) {
    void emitAssistantReplyNotification({
      conversationId,
      assistantMessageId: state.lastAssistantMessageId,
      userMessageId,
      ...(replyDeliveredInAppOnly ? { replyDeliveredInAppOnly: true } : {}),
      rlog,
      conversation,
    });
  }

  rlog.info(
    {
      criticalSectionMs,
      deferredTailMs: Date.now() - tailStartedAt,
    },
    "End-of-turn work complete",
  );
}
