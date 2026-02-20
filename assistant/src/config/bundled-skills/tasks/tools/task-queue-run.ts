import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeTaskQueueRun } from '../../../../tools/tasks/work-item-run.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeTaskQueueRun(input, context);
}
