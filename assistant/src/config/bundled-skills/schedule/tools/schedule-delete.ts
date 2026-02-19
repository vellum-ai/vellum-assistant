import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeScheduleDelete } from '../../../../tools/schedule/delete.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeScheduleDelete(input, context);
}
