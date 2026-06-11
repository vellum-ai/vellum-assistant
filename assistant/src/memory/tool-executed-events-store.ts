import { and, asc, eq, gt, isNotNull, ne, or } from "drizzle-orm";

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
  /**
   * Serialized input size in bytes. Non-null in practice: legacy rows
   * persisted before migration 278 have `arg_bytes IS NULL` and are excluded
   * from the projection entirely (see the query's legacy-row filter).
   */
  argBytes: number | null;
  /**
   * Full serialized result size in bytes. The audit listener writes it
   * together with `argBytes`, so it is non-null on every projected row in
   * practice.
   */
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
 * Legacy rows persisted before migration 278 (null `arg_bytes`) are also
 * excluded: they were already shipped under the since-reverted
 * `tool_execution` event type and lack the size/attribution columns, so
 * re-shipping them as `tool_executed` would double-count with null
 * attribution. Every post-migration writer path (tool-audit-listener.ts
 * "executed" and "error" events) always computes a non-null `arg_bytes`;
 * the only path that leaves it null ("permission_denied") is already
 * excluded by the decision filter. This makes `arg_bytes IS NOT NULL` a
 * reliable legacy-row discriminator, which in turn lets the telemetry
 * reporter use the standard 0 watermark default without dropping rows
 * recorded before its first flush.
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
    .where(
      and(
        ne(toolInvocations.decision, "denied"),
        // Legacy pre-migration-278 rows — see the doc comment above.
        isNotNull(toolInvocations.argBytes),
        cursorPredicate,
      ),
    )
    .orderBy(asc(toolInvocations.createdAt), asc(toolInvocations.id))
    .limit(limit)
    .all();
}
