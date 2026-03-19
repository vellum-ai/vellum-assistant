/**
 * Job handler for `reduce_conversation_memory`.
 *
 * Ties together the reducer service ({@link runReducer}) and the transactional
 * store ({@link applyReducerResult}) to process unreduced conversation turns
 * as a background job.
 *
 * The handler:
 *   1. Loads the conversation and validates the dirty tail marker.
 *   2. Loads the unreduced message span (messages since the dirty tail).
 *   3. Loads active time contexts and open loops for the conversation's scope.
 *   4. Includes the current `contextSummary` when present (prepended as a
 *      synthetic system message so the reducer has compacted context).
 *   5. Calls `runReducer` with the assembled input.
 *   6. Applies the result transactionally via `applyReducerResult`.
 *
 * If the reducer fails or returns an empty result, the checkpoint is NOT
 * advanced — the dirty tail stays in place so the next run retries.
 */

import { and, asc, eq, gte } from "drizzle-orm";

import { getLogger } from "../../util/logger.js";
import { type ConversationRow, getConversation } from "../conversation-crud.js";
import { getDb } from "../db.js";
import { asString } from "../job-utils.js";
import type { MemoryJob } from "../jobs-store.js";
import { type ReducerPromptInput, runReducer } from "../reducer.js";
import {
  applyReducerResult,
  getActiveOpenLoops,
  getActiveTimeContexts,
} from "../reducer-store.js";
import { EMPTY_REDUCER_RESULT } from "../reducer-types.js";
import { messages } from "../schema.js";

const log = getLogger("reduce-conversation-memory-job");

export interface ReduceConversationMemoryPayload {
  conversationId: string;
}

/**
 * Process a `reduce_conversation_memory` job.
 *
 * @throws Re-throws reducer errors so the job worker can classify and retry.
 */
export async function reduceConversationMemoryJob(
  job: MemoryJob,
): Promise<void> {
  const conversationId = asString(job.payload.conversationId);
  if (!conversationId) {
    log.warn({ jobId: job.id }, "Missing conversationId in job payload");
    return;
  }

  // ── 1. Load conversation and validate dirty tail ────────────────
  const conversation = getConversation(conversationId);
  if (!conversation) {
    log.warn(
      { jobId: job.id, conversationId },
      "Conversation not found, skipping reduction",
    );
    return;
  }

  const dirtyTailMessageId = conversation.memoryDirtyTailSinceMessageId;
  if (!dirtyTailMessageId) {
    log.debug(
      { jobId: job.id, conversationId },
      "No dirty tail marker — conversation is already fully reduced",
    );
    return;
  }

  // ── 2. Load unreduced message span ──────────────────────────────
  const unreducedMessages = loadUnreducedMessages(
    conversationId,
    dirtyTailMessageId,
  );

  if (unreducedMessages.length === 0) {
    log.debug(
      { jobId: job.id, conversationId, dirtyTailMessageId },
      "No messages found from dirty tail — nothing to reduce",
    );
    return;
  }

  // ── 3. Load active brief-state context ──────────────────────────
  const scopeId = conversation.memoryScopeId;
  const now = Date.now();

  const existingTimeContexts = getActiveTimeContexts(scopeId, now);
  const existingOpenLoops = getActiveOpenLoops(scopeId);

  // ── 4. Build reducer input ──────────────────────────────────────
  const newMessages = buildNewMessages(conversation, unreducedMessages);

  const reducerInput: ReducerPromptInput = {
    conversationId,
    newMessages,
    existingTimeContexts: existingTimeContexts.map((tc) => ({
      id: tc.id,
      summary: tc.summary,
    })),
    existingOpenLoops: existingOpenLoops.map((ol) => ({
      id: ol.id,
      summary: ol.summary,
      status: ol.status,
    })),
    nowMs: now,
    scopeId,
  };

  // ── 5. Run the reducer ──────────────────────────────────────────
  const result = await runReducer(reducerInput);

  // If the reducer returns the empty sentinel, skip applying — the dirty
  // tail stays in place so a future run can retry.
  if (result === EMPTY_REDUCER_RESULT) {
    log.warn(
      { jobId: job.id, conversationId },
      "Reducer returned empty result — not advancing checkpoint",
    );
    return;
  }

  // ── 6. Apply result transactionally ─────────────────────────────
  const lastMessage = unreducedMessages[unreducedMessages.length - 1];
  applyReducerResult({
    result,
    conversationId,
    scopeId,
    reducedThroughMessageId: lastMessage.id,
    now,
  });

  log.info(
    {
      jobId: job.id,
      conversationId,
      reducedThroughMessageId: lastMessage.id,
      messageCount: unreducedMessages.length,
      timeContextOps: result.timeContexts.length,
      openLoopOps: result.openLoops.length,
    },
    "Conversation memory reduction completed",
  );
}

// ── Internal helpers ────────────────────────────────────────────────

interface MessageRow {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

/**
 * Load messages from `dirtyTailMessageId` onward (inclusive), ordered by
 * createdAt ascending. Uses the message's createdAt as the boundary since
 * message ordering is timestamp-based.
 */
function loadUnreducedMessages(
  conversationId: string,
  dirtyTailMessageId: string,
): MessageRow[] {
  const db = getDb();

  // First, find the createdAt of the dirty tail message
  const tailMessage = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, dirtyTailMessageId))
    .get();

  if (!tailMessage) {
    return [];
  }

  // Load all messages from that timestamp onward
  return db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gte(messages.createdAt, tailMessage.createdAt),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .all();
}

/**
 * Build the `newMessages` array for the reducer input.
 *
 * When the conversation has a `contextSummary` (from context window
 * compaction), it is prepended as a synthetic `system` message so the
 * reducer has access to prior compacted context.
 */
function buildNewMessages(
  conversation: ConversationRow,
  unreducedMessages: MessageRow[],
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];

  if (conversation.contextSummary) {
    result.push({
      role: "system",
      content: `[Prior context summary] ${conversation.contextSummary}`,
    });
  }

  for (const msg of unreducedMessages) {
    result.push({ role: msg.role, content: msg.content });
  }

  return result;
}
