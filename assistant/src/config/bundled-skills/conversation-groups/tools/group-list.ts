import { executeConversationGroupList } from "../../../../tools/conversation-groups/group_list.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeConversationGroupList(input, context);
}
