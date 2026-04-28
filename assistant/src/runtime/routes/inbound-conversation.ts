/**
 * Channel conversation deletion handler.
 */
import { deleteConversationKey } from "../../memory/conversation-key-store.js";
import { deleteBindingByChannelChat } from "../../memory/external-conversation-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { BadRequestError } from "./errors.js";
import type { RouteHandlerArgs } from "./types.js";

export function handleDeleteConversation({ body = {} }: RouteHandlerArgs) {
  const { sourceChannel, conversationExternalId } = body as {
    sourceChannel?: string;
    conversationExternalId?: string;
  };

  if (!sourceChannel || typeof sourceChannel !== "string") {
    throw new BadRequestError("sourceChannel is required");
  }
  if (!conversationExternalId || typeof conversationExternalId !== "string") {
    throw new BadRequestError("conversationExternalId is required");
  }

  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;

  const scopedKey = `asst:${assistantId}:${sourceChannel}:${conversationExternalId}`;
  deleteConversationKey(scopedKey);
  if (assistantId === DAEMON_INTERNAL_ASSISTANT_ID) {
    const legacyKey = `${sourceChannel}:${conversationExternalId}`;
    deleteConversationKey(legacyKey);
    deleteBindingByChannelChat(sourceChannel, conversationExternalId);
  }

  return { ok: true };
}
