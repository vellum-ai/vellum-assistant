import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { executeDocumentCreate } from '../../../../tools/document/document-tool.js';

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeDocumentCreate(input, context);
}
