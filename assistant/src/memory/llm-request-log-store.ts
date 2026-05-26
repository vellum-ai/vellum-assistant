import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import type { LLMCallSite } from "../config/schemas/llm.js";
import { AssistantError, ProviderError } from "../util/errors.js";
import {
  getAssistantMessageIdsInTurn,
  getMessageById,
  getTurnTimeBounds,
  messageMetadataSchema,
} from "./conversation-crud.js";
import { getDb } from "./db-connection.js";
import { llmRequestLogs, messages } from "./schema.js";

export type LogRow = {
  id: string;
  conversationId: string;
  messageId: string | null;
  provider: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt: number;
  /**
   * Set on the final log row of an `AgentLoop.run` once the loop body
   * exits. NULL on intermediate rows — that's the canonical "loop kept
   * going" signal. Values are the stable strings from
   * `AgentLoopExitReason` in `agent/loop.ts`.
   */
  agentLoopExitReason: string | null;
  /**
   * Logical call site that produced this row — `mainAgent`,
   * `compactionAgent`, etc. NULL on pre-migration-264 rows (no backfill).
   * In practice values come from `LLMCallSite` (`config/schemas/llm.ts`).
   */
  callSite: string | null;
};

/**
 * Build the structured response-payload object recorded in
 * `llm_request_logs.responsePayload` for a provider-rejected LLM call.
 *
 * Mirrors the shape of a successful `usage.rawResponse` row by placing
 * the error under a top-level `error` key, so an inspector consumer can
 * branch on `row.responsePayload.error` vs the success shape without
 * parsing twice. Extracts queryable fields from `ProviderError`
 * (provider tag, status code, retry-after) and `AssistantError`
 * (structured `ErrorCode`) when present so the row isn't opaque text.
 * Other `Error` shapes degrade gracefully to `{name, message}`.
 *
 * Returns the structured object rather than a JSON string so callers
 * can either stringify it directly (daemon-path `recordRequestLog`) or
 * store it on a pending-log queue that stringifies later (wake-path
 * `PendingLog.rawResponse`), without double-encoding.
 */
export function buildProviderErrorResponsePayload(err: Error): {
  error: Record<string, unknown>;
} {
  const payload: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };
  if (err instanceof ProviderError) {
    payload.code = err.code;
    payload.provider = err.provider;
    if (err.statusCode !== undefined) {
      payload.statusCode = err.statusCode;
    }
    if (err.retryAfterMs !== undefined) {
      payload.retryAfterMs = err.retryAfterMs;
    }
  } else if (err instanceof AssistantError) {
    payload.code = err.code;
  }
  return { error: payload };
}

export function recordRequestLog(
  conversationId: string,
  requestPayload: string,
  responsePayload: string,
  messageId?: string,
  provider?: string,
  callSite?: LLMCallSite,
): string {
  const db = getDb();
  const id = uuid();
  db.insert(llmRequestLogs)
    .values({
      id,
      conversationId,
      messageId: messageId ?? null,
      provider: provider ?? null,
      requestPayload,
      responsePayload,
      createdAt: Date.now(),
      // Stamped later via setAgentLoopExitReasonOnLatestLog, once the
      // agent loop body actually exits. Intermediate rows stay NULL.
      agentLoopExitReason: null,
      // Logical call site (`mainAgent`, `compactionAgent`, …). NULL when
      // a caller hasn't been updated yet — preserves backward compat
      // while we plumb call sites through one site at a time.
      callSite: callSite ?? null,
    })
    .run();
  return id;
}

/**
 * Stamp an `agent_loop_exit_reason` onto the most-recent unstamped
 * `llm_request_logs` row for the given conversation. Called by the
 * agent-loop event dispatch (both `dispatchAgentEvent` and the wake's
 * `onEvent`) when an `agent_loop_exit` event is observed.
 *
 * The `IS NULL` guard prevents a current run from clobbering a previous
 * run's exit reason when the current run exits before landing any log
 * row of its own (reachable via `aborted_pre_call`, `aborted_via_error`
 * during pre-call setup, or `error` when system-prompt/tool resolution
 * throws). In those cases the latest row belongs to a prior run and is
 * already stamped — leave it alone.
 */
export function setAgentLoopExitReasonOnLatestLog(
  conversationId: string,
  reason: string,
): void {
  const db = getDb();
  const latest = db
    .select({ id: llmRequestLogs.id })
    .from(llmRequestLogs)
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        isNull(llmRequestLogs.agentLoopExitReason),
      ),
    )
    .orderBy(desc(llmRequestLogs.createdAt))
    .limit(1)
    .get();
  if (!latest) return;
  db.update(llmRequestLogs)
    .set({ agentLoopExitReason: reason })
    .where(eq(llmRequestLogs.id, latest.id))
    .run();
}

export function backfillMessageIdOnLogs(
  conversationId: string,
  messageId: string,
): void {
  const db = getDb();
  db.update(llmRequestLogs)
    .set({ messageId })
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        isNull(llmRequestLogs.messageId),
      ),
    )
    .run();
}

/**
 * Re-link LLM request logs from a set of source message IDs to a target
 * message. Used during message consolidation so logs from deleted
 * intermediate messages survive and remain queryable via the consolidated
 * message.
 */
export function relinkLlmRequestLogs(
  fromMessageIds: string[],
  toMessageId: string,
): void {
  if (fromMessageIds.length === 0) return;
  const db = getDb();
  db.update(llmRequestLogs)
    .set({ messageId: toMessageId })
    .where(inArray(llmRequestLogs.messageId, fromMessageIds))
    .run();
}

/**
 * Internal helper: query `llm_request_logs` for rows matching any of the
 * given message IDs, ordered by `createdAt ASC`. Uses the existing
 * `idx_llm_request_logs_message_id` index via `inArray`.
 */
function selectLogsByMessageIds(messageIds: string[]): LogRow[] {
  if (messageIds.length === 0) return [];
  const db = getDb();
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      provider: llmRequestLogs.provider,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
      agentLoopExitReason: llmRequestLogs.agentLoopExitReason,
      callSite: llmRequestLogs.callSite,
    })
    .from(llmRequestLogs)
    .where(inArray(llmRequestLogs.messageId, messageIds))
    .orderBy(llmRequestLogs.createdAt)
    .all();
}

/**
 * Query every LLM request log recorded for a conversation, ordered by
 * creation time. Conversation-scoped inspector views intentionally do
 * not apply turn recovery: the `conversation_id` column already includes
 * linked, unlinked, and orphaned rows for the full conversation.
 */
export function getRequestLogsByConversationId(conversationId: string): LogRow[] {
  const db = getDb();
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      provider: llmRequestLogs.provider,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
      agentLoopExitReason: llmRequestLogs.agentLoopExitReason,
      callSite: llmRequestLogs.callSite,
    })
    .from(llmRequestLogs)
    .where(eq(llmRequestLogs.conversationId, conversationId))
    .orderBy(asc(llmRequestLogs.createdAt), asc(llmRequestLogs.id))
    .all();
}

/**
 * Find orphaned logs — logs whose `message_id` references a message that no
 * longer exists in the DB. These are left behind when intermediate assistant
 * messages are deleted (e.g. by retry/deleteLastExchange).
 *
 * Scoped to a single conversation and a time range to avoid cross-turn bleed.
 */
function selectOrphanedLogsInRange(
  conversationId: string,
  startTime: number,
  endTime: number,
): LogRow[] {
  if (endTime <= startTime) return [];
  const db = getDb();
  // LEFT JOIN messages → filter where message row IS NULL (orphaned).
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      provider: llmRequestLogs.provider,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
      agentLoopExitReason: llmRequestLogs.agentLoopExitReason,
      callSite: llmRequestLogs.callSite,
    })
    .from(llmRequestLogs)
    .leftJoin(messages, eq(llmRequestLogs.messageId, messages.id))
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        gte(llmRequestLogs.createdAt, startTime),
        lte(llmRequestLogs.createdAt, endTime),
        sql`${messages.id} IS NULL`,
        sql`${llmRequestLogs.messageId} IS NOT NULL`,
      ),
    )
    .orderBy(llmRequestLogs.createdAt)
    .all();
}

/**
 * Find unlinked logs — logs with `message_id IS NULL` that haven't been
 * backfilled yet. This covers the race where the client queries the inspector
 * before `backfillMessageIdOnLogs` runs in `handleMessageComplete`, or when
 * the backfill fails silently (try-catch in the agent loop).
 *
 * Scoped to a single conversation and a time range to avoid cross-turn bleed.
 */
function selectUnlinkedLogsInRange(
  conversationId: string,
  startTime: number,
  endTime: number,
): LogRow[] {
  if (endTime <= startTime) return [];
  const db = getDb();
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      provider: llmRequestLogs.provider,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
      agentLoopExitReason: llmRequestLogs.agentLoopExitReason,
      callSite: llmRequestLogs.callSite,
    })
    .from(llmRequestLogs)
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        gte(llmRequestLogs.createdAt, startTime),
        lte(llmRequestLogs.createdAt, endTime),
        isNull(llmRequestLogs.messageId),
      ),
    )
    .orderBy(llmRequestLogs.createdAt)
    .all();
}

/**
 * Fetch every `compactionAgent` log row in the conversation whose
 * `createdAt` falls in the **open window** `(afterCreatedAt, beforeCreatedAt)`,
 * ordered chronologically.
 *
 * Drives the Inspector's Compaction tab. The caller resolves both
 * bounds:
 *   - `beforeCreatedAt` = the selected LLM call's `createdAt` (ceiling).
 *   - `afterCreatedAt` = the previous non-`compactionAgent` call's
 *     `createdAt` (floor), or `null` when the selected call is the first
 *     real call in the conversation.
 *
 * Both bounds are **strict**: the selected call itself never appears in
 * its own trail (`<` ceiling), and compactions that fed an earlier real
 * call's context don't bleed into this call's window (`>` floor). When
 * `afterCreatedAt` is `null` the floor is dropped entirely — every
 * preceding compaction is in scope, which is the right behavior for the
 * very first real call in the conversation.
 *
 * NULL `callSite` rows (pre-migration-264) are excluded by the explicit
 * `callSite = 'compactionAgent'` predicate without a separate IS NOT
 * NULL clause.
 */
export function getCompactionLogsBetween(
  conversationId: string,
  afterCreatedAt: number | null,
  beforeCreatedAt: number,
): LogRow[] {
  const db = getDb();
  const predicates = [
    eq(llmRequestLogs.conversationId, conversationId),
    eq(llmRequestLogs.callSite, "compactionAgent"),
    lt(llmRequestLogs.createdAt, beforeCreatedAt),
  ];
  if (afterCreatedAt !== null) {
    predicates.push(gt(llmRequestLogs.createdAt, afterCreatedAt));
  }
  return db
    .select({
      id: llmRequestLogs.id,
      conversationId: llmRequestLogs.conversationId,
      messageId: llmRequestLogs.messageId,
      provider: llmRequestLogs.provider,
      requestPayload: llmRequestLogs.requestPayload,
      responsePayload: llmRequestLogs.responsePayload,
      createdAt: llmRequestLogs.createdAt,
      agentLoopExitReason: llmRequestLogs.agentLoopExitReason,
      callSite: llmRequestLogs.callSite,
    })
    .from(llmRequestLogs)
    .where(and(...predicates))
    .orderBy(asc(llmRequestLogs.createdAt), asc(llmRequestLogs.id))
    .all();
}

/**
 * Find the `createdAt` of the most recent non-`compactionAgent` LLM
 * call in the conversation strictly before `beforeCreatedAt`, or `null`
 * when no such call exists (i.e. the cutoff is the first real call).
 *
 * Pairs with `getCompactionLogsBetween` to bound the compaction trail
 * to the window between the prior real call and the selected call.
 *
 * "Non-compactionAgent" means `callSite IS NULL OR callSite !=
 * 'compactionAgent'`. NULL rows are pre-migration-264 (no backfill) and
 * are treated as real agent calls — they were `mainAgent` in practice.
 * The OR-with-IS NULL is required because SQL's three-valued logic
 * makes `callSite != 'compactionAgent'` return UNKNOWN (not TRUE) for
 * NULL rows, which would otherwise filter them out.
 */
export function getPreviousNonCompactionCallCreatedAt(
  conversationId: string,
  beforeCreatedAt: number,
): number | null {
  const db = getDb();
  const row = db
    .select({ createdAt: llmRequestLogs.createdAt })
    .from(llmRequestLogs)
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        lt(llmRequestLogs.createdAt, beforeCreatedAt),
        or(
          isNull(llmRequestLogs.callSite),
          ne(llmRequestLogs.callSite, "compactionAgent"),
        ),
      ),
    )
    .orderBy(desc(llmRequestLogs.createdAt), desc(llmRequestLogs.id))
    .limit(1)
    .get();
  return row?.createdAt ?? null;
}

export function getRequestLogById(logId: string): LogRow | null {
  const db = getDb();
  return (
    db
      .select({
        id: llmRequestLogs.id,
        conversationId: llmRequestLogs.conversationId,
        messageId: llmRequestLogs.messageId,
        provider: llmRequestLogs.provider,
        requestPayload: llmRequestLogs.requestPayload,
        responsePayload: llmRequestLogs.responsePayload,
        createdAt: llmRequestLogs.createdAt,
        agentLoopExitReason: llmRequestLogs.agentLoopExitReason,
      callSite: llmRequestLogs.callSite,
      })
      .from(llmRequestLogs)
      .where(eq(llmRequestLogs.id, logId))
      .get() ?? null
  );
}

export function getRequestLogsByMessageId(messageId: string): LogRow[] {
  // Resolve all assistant message IDs in the same turn so the inspector
  // shows every LLM call from the entire agent turn, not just the queried message.
  const turnMessageIds = getAssistantMessageIdsInTurn(messageId);
  const turnLogs = selectLogsByMessageIds(turnMessageIds);

  // Recovery: find logs in the turn's time window that the message-ID-based
  // query missed. Two categories:
  //  1. Orphaned — messageId references a deleted message (retry/deleteLastExchange).
  //  2. Unlinked — messageId is still NULL because the backfill hasn't run yet
  //     or failed silently. This covers the race where the client queries the
  //     inspector before handleMessageComplete persists and backfills.
  const message = getMessageById(messageId);
  if (message) {
    const bounds = getTurnTimeBounds(message.conversationId, message.createdAt);
    if (bounds) {
      const orphanedLogs = selectOrphanedLogsInRange(
        message.conversationId,
        bounds.startTime,
        bounds.endTime,
      );
      const unlinkedLogs = selectUnlinkedLogsInRange(
        message.conversationId,
        bounds.startTime,
        bounds.endTime,
      );

      if (orphanedLogs.length > 0 || unlinkedLogs.length > 0) {
        const seen = new Set(turnLogs.map((l) => l.id));
        const merged = [...turnLogs];
        for (const log of [...orphanedLogs, ...unlinkedLogs]) {
          if (!seen.has(log.id)) {
            merged.push(log);
            seen.add(log.id);
          }
        }
        merged.sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        );

        // Opportunistically backfill recovered unlinked logs so future queries
        // hit the fast indexed-by-messageId path.  Guard with isNull so this
        // recovery path never overwrites a messageId already set by an
        // authoritative caller (e.g. watch-notifier).
        if (unlinkedLogs.length > 0 && turnMessageIds.length > 0) {
          try {
            const db = getDb();
            const ids = unlinkedLogs.map((l) => l.id);
            const targetMessageId = turnMessageIds[turnMessageIds.length - 1]!;
            db.update(llmRequestLogs)
              .set({ messageId: targetMessageId })
              .where(
                and(
                  inArray(llmRequestLogs.id, ids),
                  isNull(llmRequestLogs.messageId),
                ),
              )
              .run();
          } catch {
            // non-fatal — the recovery already returned the right data
          }
        }

        return merged;
      }
    }
  }

  if (turnLogs.length > 0) {
    return turnLogs;
  }

  // Fork-source fallback: if no logs found for the turn, check whether
  // the queried message was forked from a source and resolve that source's turn.
  if (!message?.metadata) {
    return [];
  }

  try {
    const parsed = messageMetadataSchema.safeParse(
      JSON.parse(message.metadata),
    );
    const sourceMessageId =
      parsed.success && typeof parsed.data.forkSourceMessageId === "string"
        ? parsed.data.forkSourceMessageId
        : null;
    if (!sourceMessageId || sourceMessageId === messageId) {
      return [];
    }
    const sourceTurnIds = getAssistantMessageIdsInTurn(sourceMessageId);
    return selectLogsByMessageIds(sourceTurnIds);
  } catch {
    return [];
  }
}
