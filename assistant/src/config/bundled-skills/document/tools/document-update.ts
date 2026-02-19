import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeDocumentUpdate } from '../../../../tools/document/document-tool.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeDocumentUpdate(input, context);
}
