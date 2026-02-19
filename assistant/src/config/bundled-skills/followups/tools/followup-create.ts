import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeFollowupCreate } from '../../../../tools/followups/followup_create.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeFollowupCreate(input, context);
}
