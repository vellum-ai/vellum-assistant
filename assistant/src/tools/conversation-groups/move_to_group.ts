import { z } from "zod";

import {
  batchSetConversationPlacement,
  getConversation,
  getDisplayMetaForConversations,
} from "../../persistence/conversation-crud.js";
import { publishConversationListAndMetadataChanged } from "../../runtime/sync/resource-sync-events.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveGroupReference } from "./group_shared.js";

/**
 * Model-input schema, `safeParse`d at the top of
 * {@link executeConversationMoveToGroup}. Same in-tool pattern and TOOLS.json
 * drift guard as the other bundled-skill tools.
 */
export const conversationMoveToGroupInputSchema = z.looseObject({
  group: nullAsOmitted(z.string()),
  conversation_id: nullAsOmitted(z.string()),
});

export async function executeConversationMoveToGroup(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = conversationMoveToGroupInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult(
      "conversation_move_to_group",
      parsedInput.error,
    );
  }

  const groupRef = parsedInput.data.group?.trim();
  if (!groupRef) {
    return {
      content: "Error: group is required (a group name or group id)",
      isError: true,
    };
  }

  const resolved = resolveGroupReference(groupRef);
  if ("error" in resolved) {
    return { content: `Error: ${resolved.error}`, isError: true };
  }
  const group = resolved.group;

  const conversationId =
    parsedInput.data.conversation_id?.trim() || context.conversationId;
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return {
      content: `Error: no conversation found with id ${conversationId}`,
      isError: true,
    };
  }

  const label = conversation.title
    ? `"${conversation.title}"`
    : `conversation ${conversationId}`;

  const meta = getDisplayMetaForConversations([conversationId]).get(
    conversationId,
  );
  if (meta?.groupId === group.id) {
    return {
      content: `${label} is already in group "${group.name}".`,
      isError: false,
    };
  }

  batchSetConversationPlacement([{ id: conversationId, groupId: group.id }]);
  publishConversationListAndMetadataChanged("reordered", [conversationId]);

  const notes: string[] = [];
  if (group.id === "system:pinned") {
    notes.push("It is now pinned.");
  }
  if (group.id === "system:scheduled" || group.id === "system:background") {
    notes.push(
      `Moving into ${group.name} demotes it out of the Recents listing.`,
    );
  }
  // Only Pinned and custom groups surface a hidden conversation. Recents is a
  // removal target, and the Scheduled/Background groups are demotions, so
  // claiming any of them made the conversation visible would misreport the
  // outcome to the model and the user.
  const surfacesConversation =
    group.id === "system:pinned" || !group.id.startsWith("system:");
  if (conversation.conversationType !== "standard" && surfacesConversation) {
    notes.push(
      `Note: this is a ${conversation.conversationType} conversation, so filing it here also surfaces it into the sidebar.`,
    );
  }

  return {
    content: [`Moved ${label} to group "${group.name}".`, ...notes].join(" "),
    isError: false,
  };
}
