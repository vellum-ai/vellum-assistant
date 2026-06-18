import { and, asc, eq, gt, lt, or, sql } from "drizzle-orm";

import { redactSensitiveFields } from "../security/redaction.js";
import type {
  TurnTrace,
  TurnTraceMessage,
  TurnTraceToolCall,
} from "../telemetry/types.js";
import { getLogger } from "../util/logger.js";
import { getDb } from "./db-connection.js";
import { messages, toolInvocations } from "./schema.js";

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

/**
 * Find the `created_at` of the next real user turn strictly after the given
 * boundary in the same conversation. Returns `null` when the boundary is the
 * latest real user turn (the window then runs to the end of the conversation).
 *
 * "Next real user turn" excludes tool-result rows persisted with role="user"
 * (same filter as the turn-event stream), so a turn that issued tool calls —
 * whose results land as role="user" rows — is not truncated at its own tool
 * results.
 */
function nextRealUserTurnCreatedAt(boundary: TurnTraceBoundary): number | null {
  const db = getDb();
  const row = db
    .select({ createdAt: messages.createdAt })
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
  return row?.createdAt ?? null;
}

/** Message rows belonging to the turn window, oldest-first. */
function queryTurnMessages(
  boundary: TurnTraceBoundary,
  nextTurnCreatedAt: number | null,
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
  const upperBound =
    nextTurnCreatedAt == null
      ? undefined
      : lt(messages.createdAt, nextTurnCreatedAt);

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

/** Parse + key-redact a stored tool-invocation input. */
function redactToolInput(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Non-JSON input — forward the raw string. Free-text inputs aren't
    // key-redactable; the consent gate is the primary protection.
    return raw;
  }
  if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return redactSensitiveFields(parsed as Record<string, unknown>);
  }
  return parsed;
}

/**
 * Tool invocations recorded inside the turn window, oldest-first.
 *
 * Window is `[userMessageCreatedAt, nextTurnCreatedAt)` on
 * `tool_invocations.created_at`. `tool_invocations` has no message-id link, so
 * the timestamp window is the correlation. The lower bound is inclusive on the
 * timestamp (a tool can fire in the same millisecond as the user message);
 * tool rows always sort after the user message in wall-clock terms.
 */
function queryTurnToolCalls(
  boundary: TurnTraceBoundary,
  nextTurnCreatedAt: number | null,
): TurnTraceToolCall[] {
  const db = getDb();
  const upperBound =
    nextTurnCreatedAt == null
      ? undefined
      : lt(toolInvocations.createdAt, nextTurnCreatedAt);

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
    input: redactToolInput(r.input),
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
 * Read-only; touches only existing tables (`messages`, `tool_invocations`), so
 * no migration is involved. Caller is responsible for the consent gate and the
 * serialized-size cap — this function always returns a faithful trace for the
 * window.
 */
export function assembleTurnTrace(boundary: TurnTraceBoundary): TurnTrace {
  const nextTurnCreatedAt = nextRealUserTurnCreatedAt(boundary);
  return {
    schema_version: 1,
    messages: queryTurnMessages(boundary, nextTurnCreatedAt),
    tool_calls: queryTurnToolCalls(boundary, nextTurnCreatedAt),
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
