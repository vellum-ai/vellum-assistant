import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../../../memory/db.js";
import { getNode, updateNode } from "../../../../memory/graph/store.js";
import { enqueueMemoryJob } from "../../../../memory/jobs-store.js";
import { memoryGraphNodes } from "../../../../memory/schema.js";
import type {
  Playbook,
  PlaybookAutonomyLevel,
} from "../../../../playbooks/types.js";
import { parsePlaybookStatement } from "../../../../playbooks/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const VALID_AUTONOMY_LEVELS = new Set<string>(["auto", "draft", "notify"]);

export async function executePlaybookUpdate(
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
    const existing = getNode(playbookId);
    if (
      !existing ||
      existing.scopeId !== scopeId ||
      !existing.sourceConversations.some((s) => s.startsWith("playbook:")) ||
      existing.fidelity === "gone"
    ) {
      return {
        content: `Error: Playbook with ID "${playbookId}" not found`,
        isError: true,
      };
    }

    // Extract the JSON statement from the content (after the first newline)
    const newlineIdx = existing.content.indexOf("\n");
    if (newlineIdx === -1) {
      return {
        content: `Error: Playbook data is corrupted for ID "${playbookId}"`,
        isError: true,
      };
    }
    const currentStatement = existing.content.slice(newlineIdx + 1);
    const currentPlaybook = parsePlaybookStatement(currentStatement);
    if (!currentPlaybook) {
      return {
        content: `Error: Playbook data is corrupted for ID "${playbookId}"`,
        isError: true,
      };
    }

    // Merge updates onto existing playbook
    const updated: Playbook = {
      trigger:
        typeof input.trigger === "string"
          ? input.trigger
          : currentPlaybook.trigger,
      channel:
        typeof input.channel === "string"
          ? input.channel
          : currentPlaybook.channel,
      category:
        typeof input.category === "string"
          ? input.category
          : currentPlaybook.category,
      action:
        typeof input.action === "string"
          ? input.action
          : currentPlaybook.action,
      autonomyLevel:
        typeof input.autonomy_level === "string" &&
        VALID_AUTONOMY_LEVELS.has(input.autonomy_level)
          ? (input.autonomy_level as PlaybookAutonomyLevel)
          : currentPlaybook.autonomyLevel,
      priority:
        typeof input.priority === "number"
          ? input.priority
          : currentPlaybook.priority,
    };

    const statement = JSON.stringify(updated);
    const subject = `Playbook: ${updated.trigger}`.slice(0, 80);
    const content = `${subject}\n${statement}`;

    // Check for duplicate content among other playbook nodes
    const db = getDb();
    const collision = db
      .select({ id: memoryGraphNodes.id })
      .from(memoryGraphNodes)
      .where(
        and(
          eq(memoryGraphNodes.scopeId, scopeId),
          sql`${memoryGraphNodes.sourceConversations} LIKE '%playbook:%'`,
          eq(memoryGraphNodes.content, content),
          sql`${memoryGraphNodes.fidelity} != 'gone'`,
          sql`${memoryGraphNodes.id} != ${existing.id}`,
        ),
      )
      .get();

    if (collision) {
      return {
        content: `Error: Another playbook with this exact configuration already exists (ID: ${collision.id}).`,
        isError: true,
      };
    }

    updateNode(existing.id, {
      content,
      lastAccessed: Date.now(),
    });

    enqueueMemoryJob("embed_graph_node", { nodeId: existing.id });

    const autonomyLabel =
      updated.autonomyLevel === "auto"
        ? "execute automatically"
        : updated.autonomyLevel === "draft"
          ? "draft for review"
          : "notify only";

    return {
      content: [
        "Playbook updated successfully.",
        `  ID: ${existing.id}`,
        `  Trigger: ${updated.trigger}`,
        `  Channel: ${updated.channel}`,
        `  Category: ${updated.category}`,
        `  Action: ${updated.action}`,
        `  Autonomy: ${autonomyLabel}`,
        `  Priority: ${updated.priority}`,
      ].join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error updating playbook: ${msg}`, isError: true };
  }
}

export { executePlaybookUpdate as run };
