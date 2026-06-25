import { executeSubagentStatus } from "../../../../tools/subagent/status.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentStatus(input, context);
}
