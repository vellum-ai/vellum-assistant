import { executeCommentReply } from "../../../../tools/document/document-comment-tool.js";
import type {
  CoreToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: CoreToolContext,
): Promise<ToolExecutionResult> {
  return executeCommentReply(input, context);
}
