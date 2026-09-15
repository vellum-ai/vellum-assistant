import { executeRecordRetrospectiveSkillDecision } from "../../../../tools/skills/record-retrospective-skill-decision.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRecordRetrospectiveSkillDecision(input, context);
}
