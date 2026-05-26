import { and, desc, eq, gte, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getDb } from "./db-connection.js";
import { compactionLogs } from "./schema.js";

/**
 * Persistence layer for `compaction_logs` (table created in migration
 * 265). Records one row per compaction event where the compactor
 * actually invoked `provider.sendMessage`. See the schema comment in
 * `schema/infrastructure.ts` for what each column means.
 *
 * Reads exist for the Inspector's Compaction Trail tab (PR 4).
 */

export type CompactionLogMode = "normal" | "emergency";

export type CompactionLogOutcome =
  | "compacted"
  | "no_change"
  | "unparseable"
  | "tail_unresolved"
  | "provider_error";

/** Cap the persisted summary excerpt — full summaries can be many KB. */
const SUMMARY_EXCERPT_MAX_CHARS = 1000;

export type CompactionLogRow = {
  id: string;
  conversationId: string;
  llmRequestLogId: string | null;
  mode: CompactionLogMode;
  outcome: CompactionLogOutcome;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  model: string | null;
  latencyMs: number;
  errorMessage: string | null;
  summaryExcerpt: string | null;
  createdAt: number;
};

export type RecordCompactionLogInput = Omit<
  CompactionLogRow,
  "id" | "createdAt"
> & {
  /** Optional override for tests; defaults to `Date.now()`. */
  createdAt?: number;
};

/**
 * Insert a new compaction event row. Returns the generated id.
 *
 * `summaryExcerpt` is automatically truncated to `SUMMARY_EXCERPT_MAX_CHARS`
 * — callers can pass the full summary text without worrying about size.
 */
export function recordCompactionLog(input: RecordCompactionLogInput): string {
  const db = getDb();
  const id = uuid();
  const createdAt = input.createdAt ?? Date.now();
  const excerpt =
    input.summaryExcerpt == null
      ? null
      : input.summaryExcerpt.length > SUMMARY_EXCERPT_MAX_CHARS
        ? input.summaryExcerpt.slice(0, SUMMARY_EXCERPT_MAX_CHARS)
        : input.summaryExcerpt;

  db.insert(compactionLogs)
    .values({
      id,
      conversationId: input.conversationId,
      llmRequestLogId: input.llmRequestLogId,
      mode: input.mode,
      outcome: input.outcome,
      beforeMessageCount: input.beforeMessageCount,
      afterMessageCount: input.afterMessageCount,
      beforeEstimatedTokens: input.beforeEstimatedTokens,
      afterEstimatedTokens: input.afterEstimatedTokens,
      maxInputTokens: input.maxInputTokens,
      thresholdTokens: input.thresholdTokens,
      summaryInputTokens: input.summaryInputTokens,
      summaryOutputTokens: input.summaryOutputTokens,
      model: input.model,
      latencyMs: input.latencyMs,
      errorMessage: input.errorMessage,
      summaryExcerpt: excerpt,
      createdAt,
    })
    .run();
  return id;
}

function rowToCompactionLog(row: typeof compactionLogs.$inferSelect): CompactionLogRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    llmRequestLogId: row.llmRequestLogId,
    mode: row.mode as CompactionLogMode,
    outcome: row.outcome as CompactionLogOutcome,
    beforeMessageCount: row.beforeMessageCount,
    afterMessageCount: row.afterMessageCount,
    beforeEstimatedTokens: row.beforeEstimatedTokens,
    afterEstimatedTokens: row.afterEstimatedTokens,
    maxInputTokens: row.maxInputTokens,
    thresholdTokens: row.thresholdTokens,
    summaryInputTokens: row.summaryInputTokens,
    summaryOutputTokens: row.summaryOutputTokens,
    model: row.model,
    latencyMs: row.latencyMs,
    errorMessage: row.errorMessage,
    summaryExcerpt: row.summaryExcerpt,
    createdAt: row.createdAt,
  };
}

/**
 * Fetch compaction events for a conversation, oldest-first. Optional
 * `since` / `until` window in ms epoch. The Inspector's Compaction
 * Trail uses this to render per-conversation history.
 */
export function getCompactionLogsByConversation(
  conversationId: string,
  opts: { since?: number; until?: number; limit?: number } = {},
): CompactionLogRow[] {
  const db = getDb();
  const conditions = [eq(compactionLogs.conversationId, conversationId)];
  if (opts.since != null) {
    conditions.push(gte(compactionLogs.createdAt, opts.since));
  }
  if (opts.until != null) {
    conditions.push(lte(compactionLogs.createdAt, opts.until));
  }

  let query = db
    .select()
    .from(compactionLogs)
    .where(and(...conditions))
    .orderBy(compactionLogs.createdAt);

  if (opts.limit != null) {
    query = query.limit(opts.limit) as typeof query;
  }

  return query.all().map(rowToCompactionLog);
}

/**
 * Fetch the most recent compaction events across all conversations.
 * Used for the cross-conversation analytics view in the Inspector.
 */
export function getRecentCompactionLogs(limit: number = 100): CompactionLogRow[] {
  const db = getDb();
  return db
    .select()
    .from(compactionLogs)
    .orderBy(desc(compactionLogs.createdAt))
    .limit(limit)
    .all()
    .map(rowToCompactionLog);
}
