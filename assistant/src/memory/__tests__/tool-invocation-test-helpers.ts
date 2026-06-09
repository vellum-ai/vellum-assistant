/**
 * Shared seeding helper for tests that exercise the tool_invocations →
 * telemetry projection chain. Inserts raw audit rows (with PII-sentinel
 * input/result payloads) plus the FK-required conversation row.
 *
 * Zero runtime imports: per the test-machinery isolation rule
 * (`assistant/AGENTS.md`), shared test helpers must not pull in source
 * modules' import-time side effects. Production types are referenced via
 * `import type` only (erased at compile time); callers pass in the real
 * `getDb()` handle and schema table refs.
 */

import type { DrizzleDb } from "../db-connection.js";
import type { conversations, toolInvocations } from "../schema.js";

/**
 * Sentinel embedded in the seeded raw input/result payloads. Assert it
 * never appears in any telemetry projection or wire payload.
 */
export const TOOL_INVOCATION_PII_SENTINEL = "must never leave the device";

export interface ToolInvocationSeedDeps {
  db: DrizzleDb;
  conversations: typeof conversations;
  toolInvocations: typeof toolInvocations;
}

export interface SeedToolInvocationSpec {
  id: string;
  createdAt: number;
  conversationId: string;
  toolName?: string;
  skillId?: string;
  decision?: string;
  riskLevel?: string;
  durationMs?: number;
}

export function seedToolInvocation(
  deps: ToolInvocationSeedDeps,
  spec: SeedToolInvocationSpec,
): void {
  // tool_invocations has an enforced FK to conversations.
  deps.db
    .insert(deps.conversations)
    .values({
      id: spec.conversationId,
      title: "test",
      createdAt: 1000,
      updatedAt: 1000,
    })
    .onConflictDoNothing()
    .run();
  deps.db
    .insert(deps.toolInvocations)
    .values({
      id: spec.id,
      conversationId: spec.conversationId,
      toolName: spec.toolName ?? "calendar_list_events",
      input: `{"secret":"raw tool args — ${TOOL_INVOCATION_PII_SENTINEL}"}`,
      result: `{"secret":"raw tool output — ${TOOL_INVOCATION_PII_SENTINEL}"}`,
      decision: spec.decision ?? "allow",
      riskLevel: spec.riskLevel ?? "low",
      skillId: spec.skillId ?? null,
      durationMs: spec.durationMs ?? 12,
      createdAt: spec.createdAt,
    })
    .run();
}
