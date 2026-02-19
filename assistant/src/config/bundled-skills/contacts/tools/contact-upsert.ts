import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeContactUpsert } from '../../../../tools/contacts/contact-upsert.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeContactUpsert(input, context);
}
