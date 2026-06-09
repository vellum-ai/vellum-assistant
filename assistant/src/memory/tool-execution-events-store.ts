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
   * Id of the skill whose `skill_execute` dispatch triggered this tool
   * call. Null for direct (non-skill) tool calls and for rows persisted
   * before migration 275 added the column.
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
      skillId: toolInvocations.skillId,
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
  return rows;
}
