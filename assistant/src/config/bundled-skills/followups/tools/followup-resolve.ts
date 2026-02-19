import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeFollowupResolve } from '../../../../tools/followups/followup_resolve.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeFollowupResolve(input, context);
}
