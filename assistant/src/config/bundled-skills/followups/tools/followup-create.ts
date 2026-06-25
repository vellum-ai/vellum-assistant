import { executeFollowupCreate } from "../../../../tools/followups/followup_create.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeFollowupCreate(input, context);
}
