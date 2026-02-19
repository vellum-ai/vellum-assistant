import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeTaskListShow } from '../../../../tools/tasks/work-item-list.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskListShow(input, context);
}
