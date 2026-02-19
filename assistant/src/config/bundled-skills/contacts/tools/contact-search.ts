import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeContactSearch } from '../../../../tools/contacts/contact-search.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeContactSearch(input, context);
}
