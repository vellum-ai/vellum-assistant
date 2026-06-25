import { executeSubagentMessage } from "../../../../tools/subagent/message.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeSubagentMessage(input, context);
}
