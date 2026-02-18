import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeBrowserExtract } from '../../../../tools/browser/browser-execution.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeBrowserExtract(input, context);
}
