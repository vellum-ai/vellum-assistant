import { executeScaffoldManagedSkill } from "../../../../tools/skills/scaffold-managed.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeScaffoldManagedSkill(input, context);
}
