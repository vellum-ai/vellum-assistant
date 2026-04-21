import {
  getConversation,
  updateConversationTitle,
} from "../../../../memory/conversation-crud.js";
import { buildAssistantEvent } from "../../../../runtime/assistant-event.js";
import { assistantEventHub } from "../../../../runtime/assistant-event-hub.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../../../runtime/assistant-scope.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getLogger } from "../../../../util/logger.js";

const log = getLogger("rename-conversation");

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const title = input.title;
  if (typeof title !== "string" || title.trim() === "") {
    return {
      content: "Error: title must be a non-empty string.",
      isError: true,
    };
  }

  const trimmedTitle = title.trim();
  const conversationId = context.conversationId;

  const conversation = getConversation(conversationId);
  if (!conversation) {
    return {
      content: `Error: conversation ${conversationId} not found.`,
      isError: true,
    };
  }

  // Persist with isAutoTitle = 0 so auto-generation won't overwrite it
  updateConversationTitle(conversationId, trimmedTitle, 0);

  // Notify the client currently viewing this conversation so the header
  // updates in-place. Scoped to this conversation so foreign
  // `conversationId` values don't leak to other subscribers' speculative
  // ID-resolution paths. Other clients learn about the rename via the
  // unscoped `conversation_list_invalidated` published below, which
  // triggers their sidebars to refetch and pick up the new title.
  const assistantId = context.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;
  assistantEventHub
    .publish(
      buildAssistantEvent(
        assistantId,
        {
          type: "conversation_title_updated",
          conversationId,
          title: trimmedTitle,
        },
        conversationId,
      ),
    )
    .catch((err) => {
      log.warn({ err }, "Failed to publish conversation_title_updated event");
    });

  // Broadcast `conversation_list_invalidated` unscoped so every connected
  // client's sidebar refetches and picks up the renamed title. Mirrors
  // the HTTP rename route in `conversation-management-routes.ts`.
  assistantEventHub
    .publish(
      buildAssistantEvent(assistantId, {
        type: "conversation_list_invalidated",
        reason: "renamed",
      }),
    )
    .catch((err) => {
      log.warn(
        { err },
        "Failed to publish conversation_list_invalidated for rename",
      );
    });

  log.info({ conversationId, title: trimmedTitle }, "Conversation renamed");

  return {
    content: `Conversation renamed to "${trimmedTitle}".`,
    isError: false,
  };
}
