import { executeTaskListUpdate } from "../../../../tools/tasks/work-item-update.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListUpdate(input, context);
}
