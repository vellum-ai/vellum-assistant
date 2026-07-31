import { executeConversationMoveToGroup } from "../../../../tools/conversation-groups/move_to_group.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeConversationMoveToGroup(input, context);
}
