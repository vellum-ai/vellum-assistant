import { executeFollowupResolve } from "../../../../tools/followups/followup_resolve.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeFollowupResolve(input, context);
}
