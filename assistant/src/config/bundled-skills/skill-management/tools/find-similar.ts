import { executeFindSimilarSkills } from "../../../../tools/skills/find-similar-skills.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeFindSimilarSkills(input, context);
}
