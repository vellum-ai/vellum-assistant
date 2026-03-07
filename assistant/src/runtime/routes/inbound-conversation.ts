/**
 * Channel conversation deletion handler.
 */
import { deleteConversationKey } from "../../memory/conversation-key-store.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError } from "../http-errors.js";

export async function handleDeleteConversation(
  req: Request,
  assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): Promise<Response> {
  const body = (await req.json()) as {
    sourceChannel?: string;
    conversationExternalId?: string;
  };

  const { sourceChannel, conversationExternalId } = body;

  if (!sourceChannel || typeof sourceChannel !== "string") {
    return httpError("BAD_REQUEST", "sourceChannel is required", 400);
  }
  if (!conversationExternalId || typeof conversationExternalId !== "string") {
    return httpError("BAD_REQUEST", "conversationExternalId is required", 400);
  }

  const scopedKey = `asst:${assistantId}:${sourceChannel}:${conversationExternalId}`;
  deleteConversationKey(scopedKey);
  // For the canonical self-assistant, also delete the legacy unscopedkey
  // and the external conversation binding (which is assistant-agnostic).
  if (assistantId === DAEMON_INTERNAL_ASSISTANT_ID) {
    const legacyKey = `${sourceChannel}:${conversationExternalId}`;
    deleteConversationKey(legacyKey);
    externalConversationStore.deleteBindingByChannelChat(
      sourceChannel,
      conversationExternalId,
    );
  }

  return Response.json({ ok: true });
}
