/**
 * Reducer scheduler — synchronous pre-switch/create reduction of the most
 * recently updated dirty conversation.
 *
 * When the user switches conversations or starts a new one, we want the
 * *previous* conversation's memory to be reduced before the next memory
 * read. This module exposes {@link reduceBeforeSwitch} which:
 *
 *   1. Finds the single most recently updated dirty conversation (excluding
 *      the target conversation).
 *   2. Runs the same reduction pipeline the background job uses (load
 *      unreduced messages, call {@link runReducer}, apply via
 *      {@link applyReducerResult}).
 *   3. Awaits the result so the caller can proceed knowing memory is fresh.
 *
 * If no eligible dirty conversation exists, the function returns immediately.
 */

import { and, asc, desc, eq, gte, isNotNull, ne } from "drizzle-orm";

import { getLogger } from "../util/logger.js";
import { type ConversationRow, getConversation } from "./conversation-crud.js";
import { getDb } from "./db.js";
import { type ReducerPromptInput, runReducer } from "./reducer.js";
import {
  applyReducerResult,
  forceAdvanceDirtyTail,
  getActiveOpenLoops,
  getActiveTimeContexts,
} from "./reducer-store.js";
import { EMPTY_REDUCER_RESULT } from "./reducer-types.js";
import { conversations, messages } from "./schema.js";

const log = getLogger("reducer-scheduler");

// ── Internal helpers ────────────────────────────────────────────────

interface MessageRow {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

/**
 * Find the single most recently updated dirty conversation, excluding
 * the target conversation. Returns the conversation ID or null if none.
 */
export function findMostRecentDirtyConversation(
  excludeConversationId: string,
): string | null {
  const db = getDb();
  const row = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        isNotNull(conversations.memoryDirtyTailSinceMessageId),
        ne(conversations.id, excludeConversationId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();

  return row?.id ?? null;
}

/**
 * Load messages from `dirtyTailMessageId` onward (inclusive), ordered by
 * createdAt ascending.
 */
function loadUnreducedMessages(
  conversationId: string,
  dirtyTailMessageId: string,
): MessageRow[] {
  const db = getDb();

  const tailMessage = db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, dirtyTailMessageId))
    .get();

  if (!tailMessage) {
    return [];
  }

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
 * Build the `newMessages` array for the reducer input, optionally
 * prepending the conversation's contextSummary as a synthetic system message.
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

// ── Public API ──────────────────────────────────────────────────────

/**
 * Reduce the most recently updated dirty conversation (excluding
 * `targetConversationId`) before a conversation switch or create.
 *
 * This runs the full reduction pipeline synchronously (awaiting the
 * provider call) so the caller can proceed knowing memory is fresh.
 *
 * Returns the conversation ID that was reduced, or null if none were eligible.
 */
export async function reduceBeforeSwitch(
  targetConversationId: string,
): Promise<string | null> {
  const dirtyConversationId =
    findMostRecentDirtyConversation(targetConversationId);

  if (!dirtyConversationId) {
    return null;
  }

  const conversation = getConversation(dirtyConversationId);
  if (!conversation) {
    return null;
  }

  const dirtyTailMessageId = conversation.memoryDirtyTailSinceMessageId;
  if (!dirtyTailMessageId) {
    return null;
  }

  // ── Load unreduced messages ──────────────────────────────────
  const unreducedMessages = loadUnreducedMessages(
    dirtyConversationId,
    dirtyTailMessageId,
  );

  if (unreducedMessages.length === 0) {
    log.debug(
      { conversationId: dirtyConversationId, dirtyTailMessageId },
      "No messages found from dirty tail — nothing to reduce on switch",
    );
    return null;
  }

  // ── Load active brief-state context ──────────────────────────
  const scopeId = conversation.memoryScopeId;
  const now = Date.now();

  const existingTimeContexts = getActiveTimeContexts(scopeId, now);
  const existingOpenLoops = getActiveOpenLoops(scopeId);

  // ── Build reducer input ──────────────────────────────────────
  const newMessages = buildNewMessages(conversation, unreducedMessages);

  const reducerInput: ReducerPromptInput = {
    conversationId: dirtyConversationId,
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

  // ── Run the reducer ──────────────────────────────────────────
  try {
    const result = await runReducer(reducerInput);

    if (result === EMPTY_REDUCER_RESULT) {
      log.debug(
        { conversationId: dirtyConversationId },
        "Reducer returned empty result on switch — not advancing checkpoint",
      );
      return null;
    }

    // ── Apply result transactionally ───────────────────────────
    const lastMessage = unreducedMessages[unreducedMessages.length - 1];
    applyReducerResult({
      result,
      conversationId: dirtyConversationId,
      scopeId,
      reducedThroughMessageId: lastMessage.id,
      now,
    });

    log.info(
      {
        conversationId: dirtyConversationId,
        reducedThroughMessageId: lastMessage.id,
        messageCount: unreducedMessages.length,
        timeContextOps: result.timeContexts.length,
        openLoopOps: result.openLoops.length,
      },
      "Pre-switch memory reduction completed",
    );

    return dirtyConversationId;
  } catch (err) {
    // runReducer only throws on fatal/permanent errors (e.g. 400 "prompt
    // too long"). Force-advance the dirty tail so every subsequent
    // conversation switch doesn't waste an API call hitting the same
    // permanent error.
    const lastMessage = unreducedMessages[unreducedMessages.length - 1];
    forceAdvanceDirtyTail(dirtyConversationId, lastMessage.id);
    log.warn(
      {
        err,
        conversationId: dirtyConversationId,
        skippedMessages: unreducedMessages.length,
        reducedThroughMessageId: lastMessage.id,
      },
      "Pre-switch memory reduction failed permanently — force-advanced dirty tail",
    );
    return null;
  }
}
