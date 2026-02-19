import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeContactMerge } from '../../../../tools/contacts/contact-merge.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeContactMerge(input, context);
}
