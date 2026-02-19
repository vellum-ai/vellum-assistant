import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeFollowupList } from '../../../../tools/followups/followup_list.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeFollowupList(input, context);
}
