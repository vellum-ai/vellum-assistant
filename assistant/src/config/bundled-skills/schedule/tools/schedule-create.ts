import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeScheduleCreate } from '../../../../tools/schedule/create.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeScheduleCreate(input, context);
}
