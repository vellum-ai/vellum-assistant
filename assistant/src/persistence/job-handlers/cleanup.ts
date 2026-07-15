import type { AssistantConfig } from "../../config/types.js";
import { rotateToolInvocations } from "../../telemetry/tool-usage-store.js";
import { getLogger } from "../../util/logger.js";
import { getLogsDbPath } from "../../util/logs-db-path.js";
import { runAsyncSqlite } from "../db-async-query.js";
import { getDb } from "../db-connection.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { rawAll, rawLogsRun, rawRun, rawTelemetryRun } from "../raw-query.js";

const log = getLogger("memory-jobs-worker");

const PRUNE_BATCH_LIMIT = 100;
const PRUNE_LOG_BATCH_LIMIT = 1000;

/**
 * Delete LLM request/response logs older than the configured retention period.
 * Processes in batches to avoid long DB locks and excessive WAL growth.
 * Re-enqueues itself if more rows remain.
 *
 * The DELETE is dispatched through `runAsyncSqlite` so it runs in a
 * sqlite3 subprocess (when available) and does not block the daemon's
 * main event loop. The two bind parameters (`cutoffMs`, batch limit)
 * are integers — they're inlined directly into the SQL after a
 * `Math.floor` + `Number.isFinite` guard so there is no string
 * interpolation surface.
 */
export async function pruneOldLlmRequestLogsJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const rawRetention = job.payload.retentionMs;
  const retentionMs =
    rawRetention === null
      ? null
      : typeof rawRetention === "number" &&
          Number.isFinite(rawRetention) &&
          rawRetention >= 0
        ? rawRetention
        : config.memory.cleanup.llmRequestLogRetentionMs;

  // null/0 means "keep forever" — skip pruning entirely. 0 is excluded (not
  // just null) to match the scheduler in maybeEnqueueScheduledCleanupJobs,
  // which no longer enqueues a retention-0 prune; guarding here too ensures a
  // job left pending from before that fix does not wipe every log on its next
  // run.
  if (retentionMs === null || retentionMs === undefined || retentionMs <= 0)
    return;

  const cutoffMs = Math.floor(Date.now() - retentionMs);
  if (!Number.isFinite(cutoffMs)) return;

  // Inline the cutoff and batch limit (both integers, both validated)
  // and chain `SELECT changes()` so we can read the row count from the
  // subprocess's stdout. The sqlite3 CLI prints `changes()` as a bare
  // integer on its own line in default output mode; the in-process
  // fallback backend in `db-async-query.ts` synthesizes the same shape
  // by capturing `changes()` atomically after `exec()`. Both backends
  // end up on the parser path below.
  // llm_request_logs lives in the dedicated logs database. Point the prune at
  // that file directly via `dbPath` — both backends open it as their own
  // database (the subprocess directly, the in-process fallback via a transient
  // connection), so the DELETE hits the right file.
  const result = await runAsyncSqlite(
    `DELETE FROM llm_request_logs WHERE rowid IN (SELECT rowid FROM llm_request_logs WHERE created_at < ${cutoffMs} LIMIT ${PRUNE_LOG_BATCH_LIMIT});
SELECT changes();`,
    "cleanup:prune-llm-request-logs",
    { dbPath: getLogsDbPath() },
  );
  if (!result.ok) {
    log.warn(
      { error: result.error, backend: result.backend },
      "pruneOldLlmRequestLogsJob: DELETE failed",
    );
    return;
  }

  const deleted = parseDeletedCount(result.stdout);

  if (deleted >= PRUNE_LOG_BATCH_LIMIT) {
    enqueueMemoryJob("prune_old_llm_request_logs", { retentionMs });
  }

  log.info(
    {
      deleted,
      retentionMs,
      cutoffMs,
    },
    "Pruned old LLM request logs",
  );
}

/**
 * Delete audit-log (`tool_invocations`) entries older than the configured
 * retention window. Retention comes from `auditLog.retentionDays` (0 = keep
 * forever). The DELETE itself lives in {@link rotateToolInvocations}; this
 * handler just resolves the window and dispatches, mirroring the other
 * scheduled cleanup jobs.
 */
export async function pruneOldToolInvocationsJob(
  job: MemoryJob,
  config: AssistantConfig,
): Promise<void> {
  const rawRetention = job.payload.retentionDays;
  const retentionDays =
    typeof rawRetention === "number" &&
    Number.isFinite(rawRetention) &&
    rawRetention >= 0
      ? rawRetention
      : config.auditLog.retentionDays;

  // 0 (or any non-positive window) means disabled — keep forever. Guarding
  // <= 0 mirrors the LLM-log prune and short-circuits before dispatching a
  // pointless async query (rotateToolInvocations no-ops on this too).
  if (retentionDays <= 0) return;

  await rotateToolInvocations(retentionDays);
}

/**
 * Parse the `SELECT changes()` result emitted by the sqlite3 CLI after
 * the prune DELETE. Returns 0 if stdout is missing or unparseable —
 * callers treat that the same as "no rows deleted, do not re-enqueue".
 *
 * In the CLI's default output mode the value is a bare integer on its
 * own line. We tolerate trailing whitespace/blank lines and pick the
 * last numeric line so any incidental output (warnings, etc.) above it
 * doesn't throw the parse off.
 */
export function _parseDeletedCount(stdout: string | undefined): number {
  return parseDeletedCount(stdout);
}

function parseDeletedCount(stdout: string | undefined): number {
  if (!stdout) return 0;
  const lines = stdout.split(/\r?\n/).filter((s) => s.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = parseInt(lines[i].trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Delete conversations that have had no activity (updatedAt) for longer than
 * the configured retention period. Processes in batches so a single job doesn't
 * hold the DB lock for too long.
 *
 * Tables with onDelete cascade on conversation FK (memory_segments,
 * conversation_keys, channel_inbound_events, message_runs, call_sessions,
 * external_conversation_bindings) are handled automatically. Tables without
 * cascade (messages, tool_invocations, plus llm_request_logs and
 * conversation-scoped telemetry_events rows on their dedicated connections)
 * are deleted explicitly before removing the conversation row.
 */
export function pruneOldConversationsJob(
  job: MemoryJob,
  config: AssistantConfig,
): void {
  const retentionDays =
    typeof job.payload.retentionDays === "number" &&
    Number.isFinite(job.payload.retentionDays) &&
    job.payload.retentionDays >= 0
      ? job.payload.retentionDays
      : config.memory.cleanup.conversationRetentionDays;

  // 0 (or any non-positive window) means disabled — keep forever. Guarding
  // <= 0 mirrors the LLM-log prune so a stray non-positive window can never
  // produce a cutoff at/after `now` that deletes live conversations.
  if (retentionDays <= 0) return;

  const cutoffMs = Date.now() - retentionDays * 86_400_000;

  const stale = rawAll<{ id: string }>(
    "cleanup:pruneOldConversations:stale",
    `SELECT id FROM conversations WHERE updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
    cutoffMs,
    PRUNE_BATCH_LIMIT,
  );
  if (stale.length === 0) return;

  const db = getDb();
  let pruned = 0;
  for (const { id } of stale) {
    db.transaction(() => {
      // Re-check staleness inside the transaction to avoid racing with a conversation
      // that became active again between the initial SELECT and this DELETE.
      const still = rawAll<{ id: string }>(
        "cleanup:pruneOldConversations:recheck",
        `SELECT id FROM conversations WHERE id = ? AND updated_at < ?`,
        id,
        cutoffMs,
      );
      if (still.length === 0) return;

      // Non-cascading tables. llm_request_logs and conversation-scoped
      // telemetry_events rows live in the dedicated logs/telemetry
      // connections, so they are deleted there (outside this main-DB
      // transaction). Both run before the main-DB deletes: a failure leaves
      // the conversation row in place so the prune retries — unshipped
      // telemetry events must never outlive their pruned conversation and
      // flush later.
      rawLogsRun(
        "cleanup:pruneOldConversations:logs",
        `DELETE FROM llm_request_logs WHERE conversation_id = ?`,
        id,
      );
      rawTelemetryRun(
        "cleanup:pruneOldConversations:telemetry",
        `DELETE FROM telemetry_events WHERE conversation_id = ?`,
        id,
      );
      rawRun(
        "cleanup:pruneOldConversations:toolInv",
        `DELETE FROM tool_invocations WHERE conversation_id = ?`,
        id,
      );
      rawRun(
        "cleanup:pruneOldConversations:messages",
        `DELETE FROM messages WHERE conversation_id = ?`,
        id,
      );
      // Conversation row deletion cascades to remaining dependent tables
      rawRun(
        "cleanup:pruneOldConversations:conv",
        `DELETE FROM conversations WHERE id = ?`,
        id,
      );
      pruned++;
    });
  }

  if (stale.length === PRUNE_BATCH_LIMIT) {
    enqueueMemoryJob("prune_old_conversations", { retentionDays });
  }

  log.info(
    {
      pruned,
      skipped: stale.length - pruned,
      retentionDays,
      cutoffMs,
    },
    "Pruned old conversations",
  );
}
