import { and, asc, eq, gt, ne, or } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { toolInvocations } from "./schema.js";

/**
 * A `tool_invocations` audit row projected for `tool_executed` telemetry
 * reporting.
 *
 * Deliberately excludes the `input` / `result` columns — raw tool
 * args/outputs are potentially PII and must never leave the device. Only the
 * payload SIZES (`argBytes` / `resultBytes`) are projected.
 */
export interface UnreportedToolExecutedEvent {
  id: string;
  toolName: string;
  /** `"allow"`-style decisions or `"error"`; never `"denied"` (filtered out). */
  decision: string;
  durationMs: number;
  /** Serialized input size in bytes. Null for rows persisted before migration 278. */
  argBytes: number | null;
  /** Full serialized result size in bytes. Null for rows persisted before migration 278. */
  resultBytes: number | null;
  provider: string | null;
  model: string | null;
  inferenceProfile: string | null;
  inferenceProfileSource: string | null;
  conversationId: string;
  createdAt: number;
}

/**
 * Query tool invocations that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 *
 * Permission-denied rows are excluded — the tool never executed, so no
 * `tool_executed` event is emitted for them.
 *
 * Rows are written by the tool audit listener
 * (`events/tool-audit-listener.ts`) — there is no record function here.
 *
 * Reporting is best-effort: `rotateToolInvocations` purges rows by
 * `created_at` alone, so rows older than the configured
 * `auditLog.retentionDays` window may be rotated away before they are
 * reported (e.g. if the daemon is offline or failing for longer than
 * the retention window).
 */
export function queryUnreportedToolExecutedEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): UnreportedToolExecutedEvent[] {
  const db = getDb();
  const cursorPredicate = afterId
    ? or(
        gt(toolInvocations.createdAt, afterCreatedAt),
        and(
          eq(toolInvocations.createdAt, afterCreatedAt),
          gt(toolInvocations.id, afterId),
        ),
      )
    : gt(toolInvocations.createdAt, afterCreatedAt);
  return db
    .select({
      id: toolInvocations.id,
      toolName: toolInvocations.toolName,
      decision: toolInvocations.decision,
      durationMs: toolInvocations.durationMs,
      argBytes: toolInvocations.argBytes,
      resultBytes: toolInvocations.resultBytes,
      provider: toolInvocations.provider,
      model: toolInvocations.model,
      inferenceProfile: toolInvocations.inferenceProfile,
      inferenceProfileSource: toolInvocations.inferenceProfileSource,
      conversationId: toolInvocations.conversationId,
      createdAt: toolInvocations.createdAt,
    })
    .from(toolInvocations)
    .where(and(ne(toolInvocations.decision, "denied"), cursorPredicate))
    .orderBy(asc(toolInvocations.createdAt), asc(toolInvocations.id))
    .limit(limit)
    .all();
}
