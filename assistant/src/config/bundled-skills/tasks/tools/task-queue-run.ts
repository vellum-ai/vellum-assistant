import { executeTaskQueueRun } from "../../../../tools/tasks/work-item-run.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskQueueRun(input, context);
}
