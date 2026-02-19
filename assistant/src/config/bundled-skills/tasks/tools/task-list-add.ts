import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeTaskListAdd } from '../../../../tools/tasks/work-item-enqueue.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListAdd(input, context);
}
