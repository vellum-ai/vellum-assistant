import { executeConversationGroupCreate } from "../../../../tools/conversation-groups/group_create.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeConversationGroupCreate(input, context);
}
