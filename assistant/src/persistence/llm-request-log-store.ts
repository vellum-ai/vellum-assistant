import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE } from "../api/constants/call-sites.js";
import { getConfigReadOnly } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { AssistantError, ProviderError } from "../util/errors.js";
import {
  getAssistantMessageIdsInTurn,
  getMessageById,
  getTurnTimeBounds,
  messageMetadataSchema,
} from "./conversation-crud.js";
import { type DrizzleDb, getDb, getLogsDb } from "./db-connection.js";
import { getClickHouseLlmRequestLogSink } from "./llm-request-log-sink-clickhouse.js";
import type {
  LlmRequestLogWriter,
  LlmRequestLogWriteRow,
} from "./llm-request-log-writer-types.js";
import { llmRequestLogs, messages } from "./schema/index.js";
import { timeSyncSection } from "./slow-sync-log.js";

/**
 * The logs connection (`assistant-logs.db`), where `llm_request_logs` lives.
 * Throws if the file cannot be opened — the store has no fallback, and a
 * missing logs DB is a genuine failure for these call sites (insert/read of
 * request logs). Callers that must not fail on this already wrap in try/catch.
 */
function logsDb(): DrizzleDb {
  const db = getLogsDb();
  if (!db) {
    throw new Error("logs database unavailable");
  }
  return db;
}

/**
 * Whether LLM request logging is enabled (`llmRequestLogs.enabled`, default
 * `true`). Gates every `llm_request_logs` insert so no prompt/completion
 * payload is written while logging is off. Read-only config access (no
 * `ensureDataDir`/disk write) because this sits on the per-LLM-call critical
 * path; defaults to "enabled" if config resolution throws so a config hiccup
 * never silently drops logs.
 */
export function llmRequestLoggingEnabled(): boolean {
  try {
    return getConfigReadOnly().llmRequestLogs?.enabled !== false;
  } catch {
    return true;
  }
}

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
  /**
   * JSON-serialized {@link LatencyBreakdown} — the daemon-measured
   * first-token latency waterfall for this main-agent call. NULL on
   * pre-instrumentation rows, failed calls, and non-main-agent call sites.
   */
  latencyBreakdown: string | null;
};

/**
 * `LogRow` without the heavy payload columns — for reads that only need
 * metadata (conversation scoping, `createdAt` anchoring). `latencyBreakdown`
 * is likewise excluded: it's per-call detail the metadata/compaction-trail
 * consumers don't surface.
 */
export type LogMetaRow = Omit<
  LogRow,
  "requestPayload" | "responsePayload" | "latencyBreakdown"
>;

/**
 * Compaction-trail row: metadata plus the (small) summarizer response
 * payload and a message count computed in SQL. The request payload — an
 * entire near-limit context window per compaction — is deliberately never
 * loaded; the trail only needs the count of messages it contained.
 */
export type CompactionAgentLogRow = LogMetaRow & {
  responsePayload: string;
  requestMessageCount: number | null;
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
 *
 * When the provider captured the verbatim upstream body, it is attached as a
 * top-level `rawResponse` sibling so the inspector's Raw tab can show the
 * actual provider payload (parsed JSON, or the raw string for non-JSON error
 * pages) — matching the success path, where Raw shows the real provider JSON.
 */
export function buildProviderErrorResponsePayload(err: Error): {
  error: Record<string, unknown>;
  rawResponse?: unknown;
} {
  const payload: Record<string, unknown> = {
    name: err.name,
    message: err.message,
  };
  let rawResponse: unknown;
  if (err instanceof ProviderError) {
    payload.code = err.code;
    payload.provider = err.provider;
    if (err.statusCode !== undefined) {
      payload.statusCode = err.statusCode;
    }
    if (err.retryAfterMs !== undefined) {
      payload.retryAfterMs = err.retryAfterMs;
    }
    if (err.apiErrorCode !== undefined) payload.apiErrorCode = err.apiErrorCode;
    if (err.apiErrorType !== undefined) payload.apiErrorType = err.apiErrorType;
    if (err.apiErrorParam !== undefined)
      payload.apiErrorParam = err.apiErrorParam;
    if (err.requestId !== undefined) payload.requestId = err.requestId;
    if (err.rawBody !== undefined) rawResponse = parseRawBody(err.rawBody);
  } else if (err instanceof AssistantError) {
    payload.code = err.code;
  }
  return rawResponse !== undefined
    ? { error: payload, rawResponse }
    : { error: payload };
}

/** Parse a captured upstream body as JSON, falling back to the raw string for
 *  non-JSON error pages (HTML, plain text) or a truncated/invalid prefix. */
function parseRawBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

/**
 * The local SQLite write backend for `llm_request_logs` — the
 * `LlmRequestLogWriter` implementation behind the default
 * `readSource: "local"` config. Holds the actual SQL for the insert and
 * every post-hoc mutation; the exported store functions dispatch here (or
 * to the ClickHouse sink) via {@link resolveLlmRequestLogWriter}.
 */
class LocalLlmRequestLogWriter implements LlmRequestLogWriter {
  insertRequestLog(row: LlmRequestLogWriteRow): void {
    const db = logsDb();
    // Synchronous insert of the full request/response payloads (an entire
    // context window for main-agent calls) into the append-only logs DB, on
    // the per-LLM-call critical path. Timed so an event-loop freeze the
    // watchdog detects can be attributed to this write (see slow-sync-log).
    timeSyncSection(
      "llm-request-log:write",
      () =>
        db
          .insert(llmRequestLogs)
          .values({
            id: row.id,
            conversationId: row.conversationId,
            messageId: row.messageId,
            provider: row.provider,
            requestPayload: row.requestPayload,
            responsePayload: row.responsePayload,
            createdAt: row.createdAt,
            agentLoopExitReason: row.agentLoopExitReason,
            callSite: row.callSite,
            latencyBreakdown: row.latencyBreakdown ?? null,
          })
          .run(),
      () => ({
        conversationId: row.conversationId,
        callSite: row.callSite,
        requestBytes: row.requestPayload.length,
        responseBytes: row.responsePayload.length,
      }),
    );
  }

  setAgentLoopExitReasonOnLatestLog(
    conversationId: string,
    reason: string,
  ): void {
    const db = logsDb();
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
    if (!latest) {
      return;
    }
    db.update(llmRequestLogs)
      .set({ agentLoopExitReason: reason })
      .where(eq(llmRequestLogs.id, latest.id))
      .run();
  }

  backfillMessageIdOnLogs(conversationId: string, messageId: string): void {
    const db = logsDb();
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

  relinkLlmRequestLogs(fromMessageIds: string[], toMessageId: string): void {
    const db = logsDb();
    db.update(llmRequestLogs)
      .set({ messageId: toMessageId })
      .where(inArray(llmRequestLogs.messageId, fromMessageIds))
      .run();
  }

  backfillMessageIdOnRecoveredLogs(logIds: string[], messageId: string): void {
    const db = logsDb();
    // Guard with isNull so this recovery path never overwrites a messageId
    // already set by an authoritative caller (e.g. watch-notifier).
    db.update(llmRequestLogs)
      .set({ messageId })
      .where(
        and(
          inArray(llmRequestLogs.id, logIds),
          isNull(llmRequestLogs.messageId),
        ),
      )
      .run();
  }
}

const LOCAL_LLM_REQUEST_LOG_WRITER = new LocalLlmRequestLogWriter();

/**
 * Resolve the write backend that currently owns `llm_request_logs` writes:
 * the ClickHouse sink when `llmRequestLogs.readSource === "clickhouse"`,
 * local SQLite otherwise. Every writer of the table — inserts AND the
 * post-hoc mutators — dispatches through this, so a backend that can't
 * support an operation expresses that as a method no-op rather than the
 * store branching per backend. Resolved fresh per call so config edits take
 * effect without a restart (same contract as the read-source factory); a
 * future third-party backend implements `LlmRequestLogWriter` and slots in
 * here.
 */
function resolveLlmRequestLogWriter(): LlmRequestLogWriter {
  return getClickHouseLlmRequestLogSink() ?? LOCAL_LLM_REQUEST_LOG_WRITER;
}

export function recordRequestLog(
  conversationId: string,
  requestPayload: string,
  responsePayload: string,
  messageId?: string,
  provider?: string,
  callSite?: LLMCallSite,
  latencyBreakdown?: string,
): string | null {
  // Master opt-out: when logging is disabled, skip the write entirely so no
  // prompt/completion payload lands on disk. Returns null — there is no row to
  // stamp/backfill later, and no production caller consumes the return value.
  if (!llmRequestLoggingEnabled()) {
    return null;
  }
  const id = uuid();
  resolveLlmRequestLogWriter().insertRequestLog({
    id,
    conversationId,
    messageId: messageId ?? null,
    provider: provider ?? null,
    requestPayload,
    responsePayload,
    createdAt: Date.now(),
    // Stamped later via setAgentLoopExitReasonOnLatestLog, once the agent
    // loop body actually exits. Intermediate rows stay NULL. (INSERT-only
    // backends never stamp — their rows keep the insert-time value.)
    agentLoopExitReason: null,
    // Logical call site (`mainAgent`, `compactionAgent`, …). NULL when a
    // caller hasn't been updated yet — preserves backward compat while we
    // plumb call sites through one site at a time.
    callSite: callSite ?? null,
    // JSON first-token latency waterfall, supplied by `handleUsage` for
    // main-agent calls. NULL for failed/non-instrumented call paths.
    latencyBreakdown: latencyBreakdown ?? null,
  });
  return id;
}

/**
 * Insert a synthetic `llm_request_logs` row for an agent-loop error
 * message that has no LLM call backing it but should appear in the
 * inspector rail. Today the only caller is the
 * `budget_yield_unrecovered` persistence path
 * (`conversation-agent-loop.ts`); the helper is named generically so
 * the next out-of-funds / provider-error / etc. path can route through
 * the same primitive.
 *
 * The caller persists the user-visible assistant message separately
 * via the `persistence` pipeline; this helper only writes the synthetic
 * call row. `messageId` should be the id of the just-persisted notice
 * so `getRequestLogsByMessageId` surfaces both together.
 *
 * Payload semantics mirror real LLM-call rows:
 *  - `requestPayload`: the best-known LLM request body the loop was
 *    about to send when it yielded — typically the prepared messages
 *    snapshot and any input-token budget context. Stored as JSON so
 *    the Raw tab renders it consistently with real calls.
 *  - `responsePayload`: the synthetic notice text the user saw plus
 *    the exit reason. This is the "response" from the user's point of
 *    view — what came back from a call that never actually happened.
 *
 * Stamps `agent_loop_exit_reason` directly so the row already carries
 * the reason at insert time — the post-loop
 * `setAgentLoopExitReasonOnLatestLog` query then skips it (its IS NULL
 * guard) and stamps the prior real LLM call instead, preserving the
 * existing "latest LLM call carries the exit reason" invariant that
 * other consumers depend on.
 */
export function recordSyntheticAgentErrorMessageLog(args: {
  conversationId: string;
  messageId: string;
  exitReason: string;
  /** User-visible notice text — goes into `response_payload`. */
  noticeText: string;
  /**
   * Best-known LLM request state at the moment the loop gave up.
   * `null` when no prepared request was available (rare — generally
   * we know at least the conversation history we were about to send).
   */
  preparedRequest: unknown | null;
  createdAt: number;
}): string | null {
  // Synthetic error rows are `llm_request_logs` rows too — honour the same
  // master opt-out so nothing is written while logging is disabled.
  if (!llmRequestLoggingEnabled()) {
    return null;
  }
  const id = uuid();
  const requestPayload = JSON.stringify({
    syntheticAgentErrorMessage: {
      exitReason: args.exitReason,
      preparedRequest: args.preparedRequest,
    },
  });
  const responsePayload = JSON.stringify({
    syntheticAgentErrorMessage: {
      exitReason: args.exitReason,
      noticeText: args.noticeText,
    },
  });
  // The exit reason is already known here, so it is carried on the row at
  // insert time — which also makes synthetic rows complete on INSERT-only
  // backends that can never stamp it afterwards.
  resolveLlmRequestLogWriter().insertRequestLog({
    id,
    conversationId: args.conversationId,
    messageId: args.messageId,
    provider: null,
    requestPayload,
    responsePayload,
    createdAt: args.createdAt,
    agentLoopExitReason: args.exitReason,
    callSite: CALL_SITE_SYNTHETIC_AGENT_ERROR_MESSAGE,
    latencyBreakdown: null,
  });
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
  resolveLlmRequestLogWriter().setAgentLoopExitReasonOnLatestLog(
    conversationId,
    reason,
  );
}

export function backfillMessageIdOnLogs(
  conversationId: string,
  messageId: string,
): void {
  resolveLlmRequestLogWriter().backfillMessageIdOnLogs(
    conversationId,
    messageId,
  );
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
  if (fromMessageIds.length === 0) {
    return;
  }
  resolveLlmRequestLogWriter().relinkLlmRequestLogs(
    fromMessageIds,
    toMessageId,
  );
}

/**
 * Internal helper: query `llm_request_logs` for rows matching any of the
 * given message IDs, ordered by `createdAt ASC`. Uses the existing
 * `idx_llm_request_logs_message_id` index via `inArray`.
 */
function selectLogsByMessageIds(messageIds: string[]): LogRow[] {
  if (messageIds.length === 0) return [];
  const db = logsDb();
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
      latencyBreakdown: llmRequestLogs.latencyBreakdown,
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
export function getRequestLogsByConversationId(
  conversationId: string,
): LogRow[] {
  const db = logsDb();
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
      latencyBreakdown: llmRequestLogs.latencyBreakdown,
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
  // `llm_request_logs` and `messages` live in separate connections now, so the
  // old LEFT JOIN can't span them. Resolve it in three steps:
  //   (a) logs conn → candidate rows in [start,end] for the conversation with a
  //       non-NULL message_id;
  //   (b) main conn → which of those message_ids still exist in `messages`;
  //   (c) filter to candidates whose message_id is NOT in the existing set.
  const candidates = logsDb()
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
      latencyBreakdown: llmRequestLogs.latencyBreakdown,
    })
    .from(llmRequestLogs)
    .where(
      and(
        eq(llmRequestLogs.conversationId, conversationId),
        gte(llmRequestLogs.createdAt, startTime),
        lte(llmRequestLogs.createdAt, endTime),
        sql`${llmRequestLogs.messageId} IS NOT NULL`,
      ),
    )
    .orderBy(llmRequestLogs.createdAt)
    .all();
  if (candidates.length === 0) return [];

  const candidateMessageIds = [
    ...new Set(candidates.map((c) => c.messageId as string)),
  ];
  const existing = new Set(
    getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.id, candidateMessageIds))
      .all()
      .map((r) => r.id),
  );

  // Orphaned = the referenced message no longer exists.
  return candidates.filter((c) => !existing.has(c.messageId as string));
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
  const db = logsDb();
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
      latencyBreakdown: llmRequestLogs.latencyBreakdown,
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
 * Return the `createdAt` of the most recent **non-`compactionAgent`** LLM
 * call in the conversation that ran strictly before `beforeCreatedAt`, or
 * `null` when no such call exists (the selected call is the first real
 * call in the conversation).
 *
 * Drives the call-scoped floor for the Inspector's Compaction tab. A
 * compaction is attributed to the next real call that runs after it, so
 * the trail for a given call is the set of compactions that landed
 * strictly between the previous real call and the selected call. NULL
 * `callSite` rows (pre-migration-264) are treated as real calls — only
 * `compactionAgent` rows are excluded.
 */
export function getPreviousNonCompactionCallCreatedAt(
  conversationId: string,
  beforeCreatedAt: number,
): number | null {
  const db = logsDb();
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
): CompactionAgentLogRow[] {
  const db = logsDb();
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
      responsePayload: llmRequestLogs.responsePayload,
      // Count the request's messages in SQL instead of loading the payload:
      // `messages` (Anthropic / OpenAI chat-completions), `contents`
      // (Gemini), `input` (OpenAI Responses). NULL when the payload is
      // malformed or none of the arrays exist.
      requestMessageCount: sql<
        number | null
      >`CASE WHEN json_valid(${llmRequestLogs.requestPayload}) THEN coalesce(
          json_array_length(${llmRequestLogs.requestPayload}, '$.messages'),
          json_array_length(${llmRequestLogs.requestPayload}, '$.contents'),
          json_array_length(${llmRequestLogs.requestPayload}, '$.input')
        ) ELSE NULL END`,
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
 * Metadata-only lookup by primary key. Used where the caller needs to
 * locate or validate a log (conversation scoping, `createdAt` anchoring)
 * without paying to load its payloads — a single request payload can be a
 * full context window.
 */
export function getRequestLogMetaById(logId: string): LogMetaRow | null {
  const db = logsDb();
  return (
    db
      .select({
        id: llmRequestLogs.id,
        conversationId: llmRequestLogs.conversationId,
        messageId: llmRequestLogs.messageId,
        provider: llmRequestLogs.provider,
        createdAt: llmRequestLogs.createdAt,
        agentLoopExitReason: llmRequestLogs.agentLoopExitReason,
        callSite: llmRequestLogs.callSite,
      })
      .from(llmRequestLogs)
      .where(eq(llmRequestLogs.id, logId))
      .get() ?? null
  );
}

export function getRequestLogById(logId: string): LogRow | null {
  const db = logsDb();
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
        latencyBreakdown: llmRequestLogs.latencyBreakdown,
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
        // hit the fast indexed-by-messageId path. Dispatched through the
        // active write backend like every other table writer — INSERT-only
        // backends no-op.
        if (unlinkedLogs.length > 0 && turnMessageIds.length > 0) {
          try {
            const ids = unlinkedLogs.map((l) => l.id);
            const targetMessageId = turnMessageIds[turnMessageIds.length - 1]!;
            resolveLlmRequestLogWriter().backfillMessageIdOnRecoveredLogs(
              ids,
              targetMessageId,
            );
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
