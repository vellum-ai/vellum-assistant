import { count, desc, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getLogger } from "../util/logger.js";
import { getDb } from "./db-connection.js";
import { toolInvocations } from "./schema.js";

export interface ToolInvocationRecord {
  conversationId: string;
  toolName: string;
  input: string;
  result: string;
  decision: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
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
 * Delete tool invocation records older than the specified number of days.
 * Returns the number of deleted records. Does nothing if retentionDays is 0.
 */
export function rotateToolInvocations(retentionDays: number): number {
  if (retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const db = getDb();

  // Count before delete (Drizzle's .run() returns void on bun-sqlite)
  const [countRow] = db
    .select({ value: count() })
    .from(toolInvocations)
    .where(lt(toolInvocations.createdAt, cutoff))
    .all();
  const toDelete = countRow?.value ?? 0;
  if (toDelete === 0) return 0;

  db.delete(toolInvocations).where(lt(toolInvocations.createdAt, cutoff)).run();
  log.info(
    `Rotated ${toDelete} audit log entries older than ${retentionDays} day(s)`,
  );
  return toDelete;
}
