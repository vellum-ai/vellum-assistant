import { executeFollowupResolve } from "../../../../tools/followups/followup_resolve.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeFollowupResolve(input, context);
}
