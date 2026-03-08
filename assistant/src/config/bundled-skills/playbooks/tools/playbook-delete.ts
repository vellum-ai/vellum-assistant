import { and, eq } from "drizzle-orm";

import { getDb } from "../../../../memory/db.js";
import { memoryItems } from "../../../../memory/schema.js";
import { parsePlaybookStatement } from "../../../../playbooks/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function executePlaybookDelete(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const playbookId = input.playbook_id as string;
  if (!playbookId || typeof playbookId !== "string") {
    return {
      content: "Error: playbook_id is required and must be a string",
      isError: true,
    };
  }

  const scopeId = context.memoryScopeId ?? "default";

  try {
    const db = getDb();

    const existing = db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.id, playbookId),
          eq(memoryItems.kind, "playbook"),
          eq(memoryItems.scopeId, scopeId),
        ),
      )
      .get();

    if (!existing) {
      return {
        content: `Error: Playbook with ID "${playbookId}" not found`,
        isError: true,
      };
    }

    const playbook = parsePlaybookStatement(existing.statement);
    const triggerLabel = playbook?.trigger ?? existing.subject;

    // Soft-delete by marking as superseded rather than hard-deleting,
    // consistent with how other memory items are retired.
    // Setting invalidAt so the cleanup job can eventually hard-delete it.
    const now = Date.now();
    db.update(memoryItems)
      .set({ status: "superseded", invalidAt: now })
      .where(eq(memoryItems.id, existing.id))
      .run();

    return {
      content: `Playbook deleted (ID: ${existing.id}, trigger: "${triggerLabel}").`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error deleting playbook: ${msg}`, isError: true };
  }
}

export { executePlaybookDelete as run };
