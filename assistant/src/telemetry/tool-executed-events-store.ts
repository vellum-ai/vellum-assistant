import { and, asc, eq, gt, isNotNull, ne, or } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { toolInvocations } from "../persistence/schema/index.js";

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
  /** Serialized raw input size in bytes. Non-null on projected rows (the null-arg-bytes filter excludes legacy and opted-out rows). */
  argBytes: number | null;
  /** Raw result size in bytes, computed before truncation/redaction and sensitive-output sanitization. */
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
 * Rows are written by the tool audit terminals (`telemetry/tool-audit.ts`) —
 * there is no record function here.
 *
 * Two row classes are excluded:
 * - Permission-denied rows: the tool never executed.
 * - Rows with null `arg_bytes`, which covers two populations:
 *   - Legacy pre-migration-278 rows: already shipped under the
 *     since-reverted `tool_execution` event type and lacking the
 *     size/attribution columns.
 *   - Rows recorded while usage data collection was opted out: the audit
 *     terminals (`telemetry/tool-audit.ts`) persist NULL telemetry columns
 *     for them at write time, making them unreportable by construction —
 *     no later opt-in or watermark race can ship them.
 *   Every opted-in post-migration writer path computes a non-null
 *   `arg_bytes` (the only other null writer, "permission_denied", is
 *   excluded by the decision filter), making `arg_bytes IS NOT NULL` a
 *   reliable discriminator. Opted-out rows recorded under builds that
 *   predate the write-time gate carry non-null columns and are guarded by
 *   the reporter's opt-out flush branch, which advances watermarks without
 *   sending (see usage-telemetry-reporter.ts).
 *
 * Reporting is best-effort: `rotateToolInvocations` purges by `created_at`
 * alone, so rows older than `auditLog.retentionDays` may rotate away before
 * they are reported.
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
