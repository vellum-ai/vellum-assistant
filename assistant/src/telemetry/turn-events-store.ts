import { and, asc, eq, gt, or, sql } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { conversations, messages } from "../persistence/schema/index.js";

export interface TurnEvent {
  id: string;
  createdAt: number;
  /**
   * Parent conversation id. Lets downstream analytics group turns by
   * conversation (e.g. avg turns per conversation).
   */
  conversationId: string;
  /**
   * Conversation type of the parent conversation. Used downstream to
   * distinguish user-initiated turns (`"standard"`) from system-generated
   * prompts in `"background"` / `"scheduled"` conversations so analytics
   * (e.g. DAU) can exclude the latter.
   */
  conversationType: string;
  /**
   * 1-indexed position of this user turn within the parent conversation,
   * counting only real user turns (tool-result rows persisted with
   * role="user" are excluded — same filter as the eligibility predicate
   * below). The first user turn in a conversation is `1`.
   *
   * Computed via correlated subquery on the same filtered set used for
   * eligibility; this scales with batch size (≤ BATCH_SIZE turns per
   * flush) and uses the `idx_messages_conversation_id` index for the
   * partition lookup.
   */
  turnIndex: number;
  /**
   * Canonical `InterfaceId` enum value identifying the UI surface the user
   * was interacting from at message-creation time (`"macos"`, `"ios"`,
   * `"cli"`, `"web"`, `"chrome-extension"`, `"slack"`, `"telegram"`,
   * `"whatsapp"`, `"email"`, `"phone"`). Sourced from
   * `messages.metadata.userMessageInterface` (stamped on insert by every
   * `persistUserMessage` path that flows through `TurnChannelContext`).
   *
   * Null when the metadata didn't carry the field — historical rows
   * predating the threading, or system-initiated turns with no inbound
   * client context. Downstream analytics should treat null as
   * `"unknown"`.
   */
  interfaceId: string | null;
  /**
   * Canonical `ChannelId` enum value identifying the messaging fabric the
   * user message arrived on (`"vellum"` for in-app messaging from
   * macos/ios/web/cli; `"slack"`/`"telegram"`/`"whatsapp"`/`"email"`/
   * `"phone"` for channel-based interfaces). Sourced from
   * `messages.metadata.userMessageChannel`.
   *
   * The 7th `ChannelId` value (`"platform"`) is APNs-push outbound-only
   * and should never appear on a user-message row.
   */
  channelId: string | null;
  /**
   * Flexible client metadata stashed under `messages.metadata.client` by
   * the HTTP header middleware. Carries optional `browserFamily`,
   * `browserVersion`, `os`, `interfaceVersion` (and is extensible without
   * a migration since it lives inside the JSON column). Null when no
   * client headers were attached.
   *
   * Returned as raw JSON text — the reporter parses + re-shapes for the
   * wire format.
   */
  clientMetadata: string | null;
  /**
   * Abnormal turn outcome stamped onto `messages.metadata.turnOutcome` at
   * turn end: `"batched"` (coalesced into a later turn's shared response),
   * `"failed"` (loop ended in a non-cancellation error), or `"cancelled"`
   * (user stop / barge-in). Null when the turn replied normally, when the
   * row predates outcome stamping, or when the process died mid-turn
   * before a stamp could land.
   */
  outcome: string | null;
  /**
   * For `"batched"` turns: `messages.id` of the batch-final turn whose
   * window carries the shared response. Null otherwise.
   */
  batchedInto: string | null;
  /**
   * For `"failed"` turns: the stable classified error code
   * (`classifyConversationError(...).code`). Null otherwise or when the
   * failure had no classification.
   */
  failureCode: string | null;
}

/**
 * SQL fragment that excludes tool-result rows persisted with role="user".
 * Kept as a single source of truth so the eligibility predicate and the
 * correlated `turn_index` count stay in lockstep — otherwise the index
 * can drift from the visible turn stream and break "first turn" /
 * "turns per conversation" math.
 *
 * `<alias>` is interpolated as the SQL identifier for the table whose
 * `content` column should be filtered (e.g. `messages` for the outer
 * query, `m2` for the correlated subquery).
 */
function realUserTurnContentFilter(alias: string): ReturnType<typeof sql> {
  return sql.raw(
    `${alias}.content NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\' ` +
      `AND ${alias}.content NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'`,
  );
}

/**
 * Query user messages (turns) that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 *
 * Joins to `conversations` so each turn carries its `conversationType`.
 * The inner join is safe because `messages.conversationId` has a
 * not-null FK to `conversations.id` (cascade on delete): every message
 * row has a matching conversation row.
 *
 * `turnIndex` is computed via a correlated subquery counting the real
 * user turns in the same conversation up to and including this row.
 */
export function queryUnreportedTurnEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): TurnEvent[] {
  const db = getDb();
  const rows = db
    .select({
      id: messages.id,
      createdAt: messages.createdAt,
      conversationId: messages.conversationId,
      conversationType: conversations.conversationType,
      // 1-indexed turn position within the parent conversation. Counts
      // only real user turns (same filter applied to the outer query).
      // `(created_at, id)` lex-comparison matches the watermark cursor
      // ordering so ties on `created_at` are broken deterministically.
      turnIndex: sql<number>`(
        SELECT COUNT(*) FROM messages AS m2
        WHERE m2.conversation_id = ${messages.conversationId}
          AND m2.role = 'user'
          AND ${realUserTurnContentFilter("m2")}
          AND (m2.created_at < ${messages.createdAt}
               OR (m2.created_at = ${messages.createdAt}
                   AND m2.id <= ${messages.id}))
      )`.as("turn_index"),
      // Client attribution: extract from `messages.metadata` JSON.
      // `userMessageInterface` and `userMessageChannel` are stamped on
      // insert by every `persistUserMessage` path that flows through
      // `TurnChannelContext`. `client` is the flexible namespace for
      // browser/os/version metadata attached by HTTP header middleware.
      // `json_extract` returns SQL NULL when the JSON path is absent —
      // exactly the null semantics we want on the wire.
      interfaceId: sql<
        string | null
      >`json_extract(${messages.metadata}, '$.userMessageInterface')`.as(
        "interface_id",
      ),
      channelId: sql<
        string | null
      >`json_extract(${messages.metadata}, '$.userMessageChannel')`.as(
        "channel_id",
      ),
      clientMetadata: sql<
        string | null
      >`json_extract(${messages.metadata}, '$.client')`.as("client_metadata"),
      // Turn-outcome stamps written at turn end (`stampTurnOutcome`).
      // `json_extract` returns SQL NULL when the path is absent — rows
      // predating outcome stamping and normally-replied turns project null.
      outcome: sql<
        string | null
      >`json_extract(${messages.metadata}, '$.turnOutcome')`.as("outcome"),
      batchedInto: sql<
        string | null
      >`json_extract(${messages.metadata}, '$.turnBatchedInto')`.as(
        "batched_into",
      ),
      failureCode: sql<
        string | null
      >`json_extract(${messages.metadata}, '$.turnFailureCode')`.as(
        "failure_code",
      ),
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(messages.role, "user"),
        // Exclude tool-result rows persisted with role "user" — these are
        // system-generated and should not count as user turns.
        // Use ESCAPE '\\' so underscores are matched literally, not as
        // single-character wildcards.
        sql`${messages.content} NOT LIKE '%"type":"tool\\_result"%' ESCAPE '\\'`,
        sql`${messages.content} NOT LIKE '%"type":"web\\_search\\_tool\\_result"%' ESCAPE '\\'`,
        afterId
          ? or(
              gt(messages.createdAt, afterCreatedAt),
              and(
                eq(messages.createdAt, afterCreatedAt),
                gt(messages.id, afterId),
              ),
            )
          : gt(messages.createdAt, afterCreatedAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit)
    .all();
  return rows;
}
