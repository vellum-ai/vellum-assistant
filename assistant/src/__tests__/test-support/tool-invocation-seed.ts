import { getDb } from "../../memory/db-connection.js";
import { conversations, toolInvocations } from "../../memory/schema.js";

/**
 * Sentinel embedded in the seeded raw input/result payloads. Tests assert it
 * never appears in any projection or wire payload — raw tool args/outputs
 * must never leave the device.
 */
export const TOOL_INVOCATION_PII_SENTINEL = "must never leave the device";

export interface ToolInvocationSeedSpec {
  id: string;
  createdAt: number;
  conversationId: string;
  toolName?: string;
  decision?: string;
  durationMs?: number;
  argBytes?: number | null;
  resultBytes?: number | null;
  provider?: string | null;
  model?: string | null;
  inferenceProfile?: string | null;
  inferenceProfileSource?: string | null;
}

/**
 * Seed a `tool_invocations` row (plus its FK conversation) for telemetry
 * projection tests. Byte sizes default to non-null — post-migration writer
 * paths always compute them; pass an explicit null to seed a legacy
 * pre-migration-278 row.
 */
export function seedToolInvocation(spec: ToolInvocationSeedSpec): void {
  const db = getDb();
  // tool_invocations has an enforced FK to conversations.
  db.insert(conversations)
    .values({
      id: spec.conversationId,
      title: "test",
      createdAt: 1000,
      updatedAt: 1000,
    })
    .onConflictDoNothing()
    .run();
  db.insert(toolInvocations)
    .values({
      id: spec.id,
      conversationId: spec.conversationId,
      toolName: spec.toolName ?? "calendar_list_events",
      input: `{"secret":"raw tool args — ${TOOL_INVOCATION_PII_SENTINEL}"}`,
      result: `{"secret":"raw tool output — ${TOOL_INVOCATION_PII_SENTINEL}"}`,
      decision: spec.decision ?? "allow",
      riskLevel: "low",
      durationMs: spec.durationMs ?? 12,
      createdAt: spec.createdAt,
      argBytes: spec.argBytes !== undefined ? spec.argBytes : 2,
      resultBytes: spec.resultBytes !== undefined ? spec.resultBytes : 9,
      provider: spec.provider ?? null,
      model: spec.model ?? null,
      inferenceProfile: spec.inferenceProfile ?? null,
      inferenceProfileSource: spec.inferenceProfileSource ?? null,
    })
    .run();
}
