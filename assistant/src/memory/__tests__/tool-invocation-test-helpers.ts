/**
 * Shared seeding helper for tests that exercise the tool_invocations →
 * telemetry projection chain. Inserts raw audit rows (with PII-sentinel
 * input/result payloads) plus the FK-required conversation row.
 *
 * No source-module imports: per the test-machinery isolation rule
 * (`assistant/AGENTS.md`), shared test helpers must not reach into
 * `src/`. Callers pass in the real `getDb()` handle and schema table
 * refs; the structural types below describe only the slice this helper
 * uses.
 */

/**
 * Sentinel embedded in the seeded raw input/result payloads. Assert it
 * never appears in any telemetry projection or wire payload.
 */
export const TOOL_INVOCATION_PII_SENTINEL = "must never leave the device";

interface SeedStatement {
  run(): unknown;
}

export interface ToolInvocationSeedDeps {
  db: {
    insert(table: unknown): {
      values(row: Record<string, unknown>): SeedStatement & {
        onConflictDoNothing(): SeedStatement;
      };
    };
  };
  conversations: unknown;
  toolInvocations: unknown;
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
