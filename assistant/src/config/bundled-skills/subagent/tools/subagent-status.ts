import { executeSubagentStatus } from "../../../../tools/subagent/status.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentStatus(input, context);
}
