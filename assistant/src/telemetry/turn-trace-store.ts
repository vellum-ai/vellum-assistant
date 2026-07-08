import { and, asc, eq, gt, lt, lte, or, sql } from "drizzle-orm";

import { findConversation } from "../daemon/conversation-registry.js";
import { getDb } from "../persistence/db-connection.js";
import { messages, toolInvocations } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";
import type {
  TurnTrace,
  TurnTraceMessage,
  TurnTraceToolCall,
} from "./types.js";

const log = getLogger("turn-trace-store");

/**
 * SQL fragment that excludes tool-result rows persisted with role="user".
 * Duplicated from `turn-events-store.ts` on purpose: a turn boundary in the
 * trace must use exactly the same notion of "real user turn" the eligibility
 * predicate / `turn_index` count use, so the trace window can never disagree
 * with the `turn` event it rides on. `<alias>` is interpolated as the SQL
 * identifier for the table whose `content` column is filtered.
 */
function realUserTurnContentFilter(alias: string): ReturnType<typeof sql> {
  return sql.raw(
    `${alias}.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\' ` +
      `AND ${alias}.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'`,
  );
}

/**
 * Identifies the user message a trace is being assembled for. Mirrors the
 * `(createdAt, id)` compound cursor the turn-event stream uses so the window
 * boundaries line up exactly.
 */
export interface TurnTraceBoundary {
  conversationId: string;
  /** `messages.id` of the real user turn that opens this turn. */
  userMessageId: string;
  /** `messages.created_at` of that user message. */
  userMessageCreatedAt: number;
}

/** Parse a stored `messages.content` string into its JSON value, verbatim. */
function parseStoredContent(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Legacy rows stored a plain (non-JSON) string. Forward as-is.
    return raw;
  }
}

/** Compound `(createdAt, id)` boundary of the next real user turn. */
interface NextTurnBoundary {
  createdAt: number;
  id: string;
}

/**
 * Find the next real user turn strictly after the given boundary in the same
 * conversation, by the same `(createdAt, id)` cursor the turn-event stream
 * uses. Returns `null` when the boundary is the latest real user turn (the
 * window then runs to the end of the conversation).
 *
 * Returns the next turn's `id` alongside its `createdAt` so the window upper
 * bound is a compound `(createdAt, id)` comparison. Two real user messages can
 * share a `created_at` (forked conversations preserve the source `created_at`
 * with fresh ids; `monotonicNow()` only guarantees monotonicity within a single
 * process), so a timestamp-only upper bound would equal the current turn's own
 * `created_at` and truncate the trace.
 *
 * "Next real user turn" excludes tool-result rows persisted with role="user"
 * (same filter as the turn-event stream), so a turn that issued tool calls —
 * whose results land as role="user" rows — is not truncated at its own tool
 * results.
 */
function nextRealUserTurn(
  boundary: TurnTraceBoundary,
): NextTurnBoundary | null {
  const db = getDb();
  const row = db
    .select({ createdAt: messages.createdAt, id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, boundary.conversationId),
        eq(messages.role, "user"),
        realUserTurnContentFilter("messages"),
        or(
          gt(messages.createdAt, boundary.userMessageCreatedAt),
          and(
            eq(messages.createdAt, boundary.userMessageCreatedAt),
            gt(messages.id, boundary.userMessageId),
          ),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Whether a turn is COMPLETE — its own assistant response has finished and the
 * full transcript is durably persisted — so its trace can be assembled without
 * risk of capturing a partial mid-turn snapshot.
 *
 * A turn is settled iff its live conversation is not actively processing.
 * `Conversation.isProcessing()` is flipped to `false` in the agent-loop
 * `finally` *after* the awaited turn-boundary commit, so a non-processing
 * conversation has no in-flight response and all of its persisted turn rows are
 * durable. A conversation absent from the live registry (evicted, or never
 * loaded this process) has no in-flight turn either, so it reads as settled —
 * including after a restart, where a turn that was mid-flight when the process
 * died reads as settled because no more rows are coming.
 *
 * Why this gates on processing for EVERY turn, not just the latest: a
 * "successor real user turn exists ⟹ settled" shortcut is unsound in the
 * batched-message path. When queued messages drain as a batch, `drainBatch`
 * (daemon/conversation-process.ts) persists the head user row AND the tail user
 * rows up front, then runs ONE shared `runAgentLoop` whose response is
 * broadcast to all of them. So the batched HEAD turn has a later real user row
 * (a tail) while the shared response and its tool calls are still in flight —
 * the shortcut would mark the head settled and ship a trace missing the shared
 * response, never retried. Gating on `isProcessing()` defers the head (and any
 * backlog) until the shared response completes and the conversation goes idle.
 *
 * Turns are serialized per conversation and `isProcessing()` is per-response,
 * so the conversation is idle between turns and completed past turns settle
 * promptly; the only cost is that a just-finished turn waits for the current
 * response when one started before it could be reported — minimal latency,
 * preferred over shipping a partial trace.
 *
 * The `isProcessing()` read relies on the daemon's in-memory state, so the
 * reporter and the agent loop share one process (they do — both live in the
 * daemon).
 */
export function isTurnSettled(boundary: TurnTraceBoundary): boolean {
  return findConversation(boundary.conversationId)?.isProcessing() !== true;
}

/** Message rows belonging to the turn window, oldest-first. */
function queryTurnMessages(
  boundary: TurnTraceBoundary,
  nextTurn: NextTurnBoundary | null,
): TurnTraceMessage[] {
  const db = getDb();
  // Lower bound: the user message itself (inclusive), using the same
  // `(createdAt, id)` lex-comparison as the cursor so a row sharing the
  // user message's millisecond isn't dropped.
  const lowerBound = or(
    gt(messages.createdAt, boundary.userMessageCreatedAt),
    and(
      eq(messages.createdAt, boundary.userMessageCreatedAt),
      sql`${messages.id} >= ${boundary.userMessageId}`,
    ),
  );
  // Upper bound: strictly before the next real user turn, using the same
  // compound `(createdAt, id)` comparison. A timestamp-only bound would empty
  // the window when the next user turn shares this turn's `created_at`.
  const upperBound =
    nextTurn == null
      ? undefined
      : or(
          lt(messages.createdAt, nextTurn.createdAt),
          and(
            eq(messages.createdAt, nextTurn.createdAt),
            sql`${messages.id} < ${nextTurn.id}`,
          ),
        );

  const rows = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, boundary.conversationId),
        lowerBound,
        ...(upperBound ? [upperBound] : []),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all();

  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    created_at: r.createdAt,
    content: parseStoredContent(r.content),
  }));
}

/**
 * Parse a stored tool-invocation input verbatim.
 *
 * The consented trace is full-fidelity: the input is forwarded exactly as
 * stored (structured JSON when it parses, raw string otherwise — symmetric
 * with how message content is handled). No field-level redaction is applied;
 * the protections for this PII are the consent gate, the PII-segregated
 * `pii_turn_raw` table, and its 30-day TTL.
 */
function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Non-JSON input — forward the raw string verbatim.
    return raw;
  }
}

/**
 * Tool invocations recorded inside the turn window, oldest-first.
 *
 * `tool_invocations` has no message-id link and its ids are unrelated to
 * `messages.id`, so the window is correlated purely by `created_at`:
 * `[userMessageCreatedAt, nextTurn.createdAt)`. The lower bound is inclusive
 * (a tool can fire in the same millisecond as the user message).
 *
 * Degenerate same-`created_at` case: when the next real user turn shares this
 * turn's `created_at`, a strict `<` upper bound yields an empty `[X, X)` window
 * and drops this turn's same-millisecond tools. In that case the upper bound is
 * widened to `<=` so those tools are retained. Same-millisecond tools cannot be
 * attributed to one of two colliding user turns by timestamp alone; including
 * them in the earlier turn matches the message window (which keeps this turn's
 * rows at that millisecond) and is the conservative choice for a diagnostic
 * trace.
 */
function queryTurnToolCalls(
  boundary: TurnTraceBoundary,
  nextTurn: NextTurnBoundary | null,
): TurnTraceToolCall[] {
  const db = getDb();
  let upperBound;
  if (nextTurn == null) {
    upperBound = undefined;
  } else if (nextTurn.createdAt <= boundary.userMessageCreatedAt) {
    // Next turn collides on (or, defensively, predates) this turn's
    // millisecond — keep tools at that millisecond instead of emptying the
    // window.
    upperBound = lte(toolInvocations.createdAt, nextTurn.createdAt);
  } else {
    upperBound = lt(toolInvocations.createdAt, nextTurn.createdAt);
  }

  const rows = db
    .select({
      id: toolInvocations.id,
      toolName: toolInvocations.toolName,
      input: toolInvocations.input,
      result: toolInvocations.result,
      decision: toolInvocations.decision,
      durationMs: toolInvocations.durationMs,
      createdAt: toolInvocations.createdAt,
    })
    .from(toolInvocations)
    .where(
      and(
        eq(toolInvocations.conversationId, boundary.conversationId),
        sql`${toolInvocations.createdAt} >= ${boundary.userMessageCreatedAt}`,
        ...(upperBound ? [upperBound] : []),
      ),
    )
    .orderBy(asc(toolInvocations.createdAt), asc(toolInvocations.id))
    .all();

  return rows.map((r) => ({
    id: r.id,
    tool_name: r.toolName,
    input: parseToolInput(r.input),
    result: r.result,
    decision: r.decision,
    duration_ms: r.durationMs,
    created_at: r.createdAt,
  }));
}

/**
 * Assemble the full transcript for one turn: the user message, the assistant
 * response message(s), any intervening tool-result rows, and the tool
 * invocations recorded for the turn — bounded to the window between this real
 * user turn and the next one.
 *
 * The trace is each turn's natural window. A turn whose own window holds no
 * assistant response (a coalesced-batch head, or a turn that failed/cancelled
 * before producing a response) traces user-only, which is faithful: its window
 * genuinely has no response. A coalesced batch's shared response lives on the
 * batch's FINAL turn's window — exactly where the daemon already attributes it
 * (via `lastUserMessageId` / `llm_usage` / `turn_index`). Which case an empty
 * window is (batched vs failed vs cancelled) is recorded durably on the user
 * message row (`messages.metadata.turnOutcome`, written by `stampTurnOutcome`)
 * and rides the turn event's `outcome` field — the trace itself stays the
 * plain window and attempts no inference.
 *
 * Read-only; touches only existing tables (`messages`, `tool_invocations`), so
 * no migration is involved. Caller is responsible for the consent gate and the
 * serialized-size cap — this function always returns a faithful trace for the
 * window.
 */
export function assembleTurnTrace(boundary: TurnTraceBoundary): TurnTrace {
  const nextTurn = nextRealUserTurn(boundary);
  return {
    schema_version: 1,
    messages: queryTurnMessages(boundary, nextTurn),
    tool_calls: queryTurnToolCalls(boundary, nextTurn),
  };
}

/**
 * Maximum serialized size of a trace the platform will accept (it drops traces
 * whose JSON exceeds ~256 KiB). Keep the daemon-side cap a touch under that so
 * we never ship a trace the platform will silently drop. A trace over the cap
 * is omitted entirely (the trace-free turn row still flushes).
 */
export const MAX_TRACE_SERIALIZED_BYTES = 256 * 1024;

/**
 * Assemble a turn trace and serialize it, returning the JSON-ready object only
 * when it fits under {@link MAX_TRACE_SERIALIZED_BYTES}. Returns `null` (no
 * trace) when assembly fails or the trace is too large — both fail-closed so a
 * single oversized/broken turn never blocks the turn event from flushing.
 */
export function assembleBoundedTurnTrace(
  boundary: TurnTraceBoundary,
): TurnTrace | null {
  let trace: TurnTrace;
  try {
    trace = assembleTurnTrace(boundary);
  } catch (err) {
    log.warn(
      { err, conversationId: boundary.conversationId },
      "Failed to assemble turn trace — omitting trace for this turn",
    );
    return null;
  }

  let serializedBytes: number;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(trace), "utf8");
  } catch (err) {
    log.warn(
      { err, conversationId: boundary.conversationId },
      "Failed to serialize turn trace — omitting trace for this turn",
    );
    return null;
  }

  if (serializedBytes > MAX_TRACE_SERIALIZED_BYTES) {
    log.debug(
      {
        conversationId: boundary.conversationId,
        serializedBytes,
        cap: MAX_TRACE_SERIALIZED_BYTES,
      },
      "Turn trace exceeds size cap — omitting trace for this turn",
    );
    return null;
  }

  return trace;
}
