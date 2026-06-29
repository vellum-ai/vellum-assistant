/**
 * Channel conversation deletion handler.
 */
import {
  deleteConversationKey,
  getOrCreateConversation,
} from "../../persistence/conversation-key-store.js";
import { buildScopedConversationKey } from "../../persistence/delivery-crud.js";
import {
  deleteBindingByChannelChat,
  deleteBindingByChannelChatThread,
} from "../../persistence/external-conversation-store.js";
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

  const normalizedThreadId = sourceThreadId?.trim() || undefined;

  const scopedKey = buildScopedConversationKey(
    sourceChannel,
    conversationExternalId,
    normalizedThreadId,
  );
  deleteConversationKey(scopedKey);
  const legacyKey = `${sourceChannel}:${conversationExternalId}`;
  if (!normalizedThreadId) {
    deleteConversationKey(legacyKey);
    deleteBindingByChannelChat(sourceChannel, conversationExternalId);
  } else {
    if (sourceChannel === "slack") {
      getOrCreateConversation(scopedKey);
    }
    deleteBindingByChannelChatThread(
      sourceChannel,
      conversationExternalId,
      normalizedThreadId,
    );
  }

  return { ok: true };
}
