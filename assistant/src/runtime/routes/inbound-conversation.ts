/**
 * Channel conversation deletion handler.
 */
import { deleteConversationKey } from "../../memory/conversation-key-store.js";
import { buildScopedConversationKey } from "../../memory/delivery-crud.js";
import {
  deleteBindingByChannelChat,
  deleteBindingByChannelChatThread,
} from "../../memory/external-conversation-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { BadRequestError } from "./errors.js";
import type { RouteHandlerArgs } from "./types.js";

export function handleDeleteConversation({ body = {} }: RouteHandlerArgs) {
  const { sourceChannel, conversationExternalId, sourceThreadId } = body as {
    sourceChannel?: string;
    conversationExternalId?: string;
    sourceThreadId?: string;
  };

  if (!sourceChannel || typeof sourceChannel !== "string") {
    throw new BadRequestError("sourceChannel is required");
  }
  if (!conversationExternalId || typeof conversationExternalId !== "string") {
    throw new BadRequestError("conversationExternalId is required");
  }

  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const normalizedThreadId = sourceThreadId?.trim() || undefined;

  const scopedKey = buildScopedConversationKey(
    assistantId,
    sourceChannel,
    conversationExternalId,
    normalizedThreadId,
  );
  deleteConversationKey(scopedKey);
  if (assistantId === DAEMON_INTERNAL_ASSISTANT_ID) {
    const legacyKey = `${sourceChannel}:${conversationExternalId}`;
    if (!normalizedThreadId) {
      deleteConversationKey(legacyKey);
      deleteBindingByChannelChat(sourceChannel, conversationExternalId);
    } else {
      deleteBindingByChannelChatThread(
        sourceChannel,
        conversationExternalId,
        normalizedThreadId,
      );
    }
  }

  return { ok: true };
}
