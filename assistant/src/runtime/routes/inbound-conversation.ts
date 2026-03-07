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
  // external_conversation_bindings is currently assistant-agnostic
  // (unique by sourceChannel + externalChatId). Restrict mutations to the
  // canonical self-assistant route so multi-assistant legacy routes do not
  // clobber each other's bindings.
  if (assistantId === DAEMON_INTERNAL_ASSISTANT_ID) {
    externalConversationStore.deleteBindingByChannelChat(
      sourceChannel,
      conversationExternalId,
    );
  }

  return Response.json({ ok: true });
}
