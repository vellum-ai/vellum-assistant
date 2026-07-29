import { z } from "zod";

import { createGroup, listGroups } from "../../persistence/group-crud.js";
import { publishConversationListChanged } from "../../runtime/sync/resource-sync-events.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of
 * {@link executeConversationGroupCreate}. Same in-tool pattern and TOOLS.json
 * drift guard as the other bundled-skill tools. The bespoke non-empty (trim)
 * check keeps its own error message.
 */
export const conversationGroupCreateInputSchema = z.looseObject({
  name: nullAsOmitted(z.string()),
});

export async function executeConversationGroupCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = conversationGroupCreateInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult(
      "conversation_group_create",
      parsedInput.error,
    );
  }

  const name = parsedInput.data.name?.trim();
  if (!name) {
    return {
      content: "Error: name is required and must be a non-empty string",
      isError: true,
    };
  }

  const existing = listGroups().find(
    (g) => g.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (existing?.isSystemGroup) {
    return {
      content: `Error: "${existing.name}" is a built-in system group and cannot be recreated. Move conversations into it directly with conversation_move_to_group.`,
      isError: true,
    };
  }
  if (existing) {
    return {
      content: `Group "${existing.name}" already exists (id: ${existing.id}). Reusing it — no new group was created.`,
      isError: false,
    };
  }

  const group = createGroup(name);
  publishConversationListChanged("created");
  return {
    content: `Created group "${group.name}" (id: ${group.id}). It now appears in the sidebar; use conversation_move_to_group to file conversations into it.`,
    isError: false,
  };
}
