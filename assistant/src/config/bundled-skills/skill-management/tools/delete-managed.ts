import { executeDeleteManagedSkill } from "../../../../tools/skills/delete-managed.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeDeleteManagedSkill(input, context);
}
