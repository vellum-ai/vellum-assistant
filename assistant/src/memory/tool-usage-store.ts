import { count, desc, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { runAsyncSqlite } from "../persistence/db-async-query.js";
import { getDb } from "../persistence/db-connection.js";
import { toolInvocations } from "../persistence/schema/index.js";
import { getLogger } from "../util/logger.js";

export interface ToolInvocationRecord {
  conversationId: string;
  toolName: string;
  input: string;
  result: string;
  decision: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  /** Serialized input size in bytes, computed before any redaction. */
  argBytes?: number | null;
  /** Full serialized result size in bytes, computed before truncation/redaction. */
  resultBytes?: number | null;
  provider?: string | null;
  model?: string | null;
  inferenceProfile?: string | null;
  inferenceProfileSource?: string | null;
}

export function recordToolInvocation(record: ToolInvocationRecord): void {
  const db = getDb();
  db.insert(toolInvocations)
    .values({
      id: uuid(),
      conversationId: record.conversationId,
      toolName: record.toolName,
      input: record.input,
      result: record.result,
      decision: record.decision,
      riskLevel: record.riskLevel,
      matchedTrustRuleId: record.matchedTrustRuleId,
      durationMs: record.durationMs,
      createdAt: Date.now(),
      argBytes: record.argBytes,
      resultBytes: record.resultBytes,
      provider: record.provider,
      model: record.model,
      inferenceProfile: record.inferenceProfile,
      inferenceProfileSource: record.inferenceProfileSource,
    })
    .run();
}

export function getRecentInvocations(limit: number) {
  const db = getDb();
  return db
    .select()
    .from(toolInvocations)
    .orderBy(desc(toolInvocations.createdAt))
    .limit(limit)
    .all();
}

const log = getLogger("audit-log");

/**
 * Delete tool invocation records older than the specified number of
 * days. Returns the number of deleted records. Does nothing if
 * `retentionDays` is zero, negative, or non-finite.
 *
 * The DELETE runs through {@link runAsyncSqlite}: when the host has a
 * `sqlite3` CLI it executes in a subprocess and the daemon's main
 * event loop stays responsive. On hosts without the CLI the
 * abstraction falls back to in-process blocking execution — the same
 * behaviour the daemon had before this abstraction existed.
 */
export async function rotateToolInvocations(
  retentionDays: number,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  // Math.floor guarantees a plain integer literal in the inlined SQL
  // below; no decimal, no exponent, no surprise characters.
  const cutoffMs = Math.floor(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const db = getDb();

  // Count before delete so we can return + log the affected row count
  // (`runAsyncSqlite` does not surface SQLite's `changes()` value).
  const [countRow] = db
    .select({ value: count() })
    .from(toolInvocations)
    .where(lt(toolInvocations.createdAt, cutoffMs))
    .all();
  const toDelete = countRow?.value ?? 0;
  if (toDelete === 0) return 0;

  // `runAsyncSqlite` takes a raw SQL string — sqlite3 CLI subprocesses
  // see SQL on stdin without a binding layer. `cutoffMs` is a plain
  // integer (see Math.floor above), so inlining it here is safe.
  const result = await runAsyncSqlite(
    `DELETE FROM tool_invocations WHERE created_at < ${cutoffMs}`,
    "tool-usage-store:prune-tool-invocations",
  );
  if (!result.ok) {
    log.error(
      { error: result.error, backend: result.backend, toDelete },
      "tool_invocations purge failed",
    );
    return 0;
  }

  log.info(
    `Rotated ${toDelete} audit log entries older than ${retentionDays} day(s)`,
  );
  return toDelete;
}
