import { listGroups } from "../../persistence/group-crud.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { formatGroupList } from "./group_shared.js";

export async function executeConversationGroupList(
  _input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const groups = listGroups();
  return {
    content:
      "Conversation groups (sidebar order):\n" +
      formatGroupList(groups) +
      "\n\nSystem groups are built in: Pinned pins a conversation, Recents " +
      "(system:all) is the default ungrouped section, and Scheduled/" +
      "Background hold automated conversations. Custom groups are " +
      "user-defined sections.",
    isError: false,
  };
}
