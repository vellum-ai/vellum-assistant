import { executeDocumentDelete } from "../../../../tools/document/document-tool.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeDocumentDelete(input, context);
}
