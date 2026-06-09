import { and, asc, eq, gt, or } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { toolInvocations } from "./schema.js";

/**
 * A `tool_invocations` audit row projected for telemetry reporting.
 *
 * Deliberately excludes the `input` / `result` columns — raw tool
 * args/outputs are potentially PII and must never leave the device.
 */
export interface UnreportedToolExecutionEvent {
  id: string;
  toolName: string;
  /**
   * Triggering skill id. The `tool_invocations` table does not carry a
   * skill column yet, so this is always null for now; the field exists so
   * adding the column is a one-line change here.
   */
  skillId: string | null;
  decision: string;
  riskLevel: string;
  durationMs: number;
  conversationId: string;
  createdAt: number;
}

/**
 * Query tool invocations that haven't been reported to telemetry yet.
 * Uses a compound cursor (createdAt + id) for reliable watermarking.
 *
 * Rows are written by the tool audit listener
 * (`events/tool-audit-listener.ts`) — there is no record function here.
 */
export function queryUnreportedToolExecutionEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): UnreportedToolExecutionEvent[] {
  const db = getDb();
  const rows = db
    .select({
      id: toolInvocations.id,
      toolName: toolInvocations.toolName,
      decision: toolInvocations.decision,
      riskLevel: toolInvocations.riskLevel,
      durationMs: toolInvocations.durationMs,
      conversationId: toolInvocations.conversationId,
      createdAt: toolInvocations.createdAt,
    })
    .from(toolInvocations)
    .where(
      afterId
        ? or(
            gt(toolInvocations.createdAt, afterCreatedAt),
            and(
              eq(toolInvocations.createdAt, afterCreatedAt),
              gt(toolInvocations.id, afterId),
            ),
          )
        : gt(toolInvocations.createdAt, afterCreatedAt),
    )
    .orderBy(asc(toolInvocations.createdAt), asc(toolInvocations.id))
    .limit(limit)
    .all();
  return rows.map((r) => ({ ...r, skillId: null }));
}
