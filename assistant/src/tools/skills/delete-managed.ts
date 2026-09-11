import { refreshSkillCapabilityMemories } from "../../daemon/skill-memory-refresh.js";
import { deleteManagedSkill } from "../../skills/managed-store.js";
import { throwIfCancelled } from "../shared/abort.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Core execution logic for delete_managed_skill.
 * Exported so bundled-skill executors and tests can call it directly.
 */
export async function executeDeleteManagedSkill(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const skillId = input.skill_id;
  if (typeof skillId !== "string" || !skillId.trim()) {
    return {
      content: "Error: skill_id is required and must be a non-empty string",
      isError: true,
    };
  }

  throwIfCancelled(context);

  const result = deleteManagedSkill(skillId.trim());

  if (!result.deleted) {
    return { content: `Error: ${result.error}`, isError: true };
  }

  refreshSkillCapabilityMemories();

  return {
    content: JSON.stringify({
      deleted: true,
      skill_id: skillId.trim(),
    }),
    isError: false,
  };
}
