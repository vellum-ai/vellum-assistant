import { executeDocumentReplaceText } from "../../../../tools/document/document-tool.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeDocumentReplaceText(input, context);
}
