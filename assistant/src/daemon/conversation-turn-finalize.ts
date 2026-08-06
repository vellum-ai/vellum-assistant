/**
 * End-of-turn finalize work that runs OFF the send-button critical path.
 *
 * The web/Capacitor/CLI clients re-enable the composer the moment they observe
 * the terminal `message_complete` / `assistant_activity_state("idle")` SSE, so
 * any awaited work between the last streamed token and that emission is what the
 * user perceives as the "still spinning after the reply finished" gap.
 *
 * None of the work here gates delivery of the reply: memory/attention indexing
 * only feeds the NEXT turn's retrieval and a sidebar indicator, tool-result
 * truncation only reshapes the in-memory history the next turn is built from,
 * and the disk-view mirror is a durability convenience. The agent loop persists
 * the reply content synchronously and emits the terminal SSE first, then drains
 * this module's work before the turn's `finally` starts the next turn — so the
 * bookkeeping still completes within the turn, just after the composer is free.
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

/** Minimal live-conversation surface the deferred tail reads and rewrites. */
interface TurnTailContext {
  readonly conversationId: string;
  messages: Message[];
}

/** Minimal per-run handler state the deferred tail consumes. */
interface TurnTailState {
  readonly deferredFinalizeEffects: ReadonlyArray<() => Promise<void>>;
  readonly lastAssistantMessageId: string | undefined;
  /** In-flight content writers the turn left behind (see EventHandlerState). */
  readonly inflightWriters: Map<string, InflightContentWriter>;
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
 * Drain a turn's deferred bookkeeping after the terminal SSE has re-enabled the
 * composer but before the agent loop's `finally` commits and drains the queue
 * for the next turn. Ordering with the next turn is preserved (this completes
 * before `drainQueue`), while the last-token→send-button latency no longer
 * includes it. Every step is best-effort.
 *
 * `generationCompletedAt` is stamped when the agent loop returns; the emitted
 * `criticalSectionMs` / `deferredTailMs` split makes the previously-uninstrumented
 * end-of-turn window measurable.
 */
export async function runDeferredTurnTail(params: {
  ctx: TurnTailContext;
  state: TurnTailState;
  rlog: pino.Logger;
  generationCompletedAt: number;
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
    ctx,
    state,
    rlog,
    generationCompletedAt,
    turnCompleted,
    userMessageId,
    replyDeliveredInAppOnly,
  } = params;
  const tailStartedAt = Date.now();

  // Conversation row for the notification producer below. Guarded like every
  // step below, because this runs after the terminal SSE and a SQLite hiccup
  // must not escape into the loop's outer catch.
  let conversation: ConversationRow | null = null;
  try {
    conversation = getConversation(ctx.conversationId);
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
  // cursor this turn's last row just projected. Not awaited: the pipeline
  // awaits the platform adapter's HTTP dispatch, which retries with backoff,
  // and nothing below here depends on the emit. The producer never rejects.
  if (turnCompleted && state.lastAssistantMessageId) {
    void emitAssistantReplyNotification({
      conversationId: ctx.conversationId,
      assistantMessageId: state.lastAssistantMessageId,
      userMessageId,
      ...(replyDeliveredInAppOnly ? { replyDeliveredInAppOnly: true } : {}),
      rlog,
      conversation,
    });
  }

  // Fresh row for the two filesystem steps below. The awaited work above is
  // long enough for the user to delete the conversation, and the row read at
  // the top of the tail stays truthy across that deletion, so spooling or
  // mirroring against it would rebuild a deleted conversation's directory from
  // in-memory history. A row that is gone skips both steps exactly as an
  // unreadable one does.
  let liveConversation: ConversationRow | null = null;
  try {
    liveConversation = getConversation(ctx.conversationId);
  } catch (err) {
    rlog.warn({ err }, "Failed to re-read conversation for end-of-turn work");
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

  rlog.info(
    {
      criticalSectionMs: tailStartedAt - generationCompletedAt,
      deferredTailMs: Date.now() - tailStartedAt,
    },
    "End-of-turn work complete",
  );
}
