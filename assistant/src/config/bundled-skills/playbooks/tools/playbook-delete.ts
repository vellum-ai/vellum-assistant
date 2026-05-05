import { getNode, updateNode } from "../../../../memory/graph/store.js";
import { parsePlaybookStatement } from "../../../../playbooks/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function executePlaybookDelete(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const playbookId = input.playbook_id as string;
  if (!playbookId || typeof playbookId !== "string") {
    return {
      content: "Error: playbook_id is required and must be a string",
      isError: true,
    };
  }

  const scopeId = "default";

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

    // Extract trigger label from content
    const newlineIdx = existing.content.indexOf("\n");
    const statement =
      newlineIdx !== -1 ? existing.content.slice(newlineIdx + 1) : "";
    const playbook = parsePlaybookStatement(statement);
    const triggerLabel = playbook?.trigger ?? existing.content.split("\n")[0];

    // Soft-delete by setting fidelity to "gone"
    updateNode(existing.id, { fidelity: "gone" });

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
