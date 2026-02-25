/**
 * Channel conversation deletion handler.
 */
import { deleteConversationKey } from '../../memory/conversation-key-store.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';

export async function handleDeleteConversation(req: Request, assistantId: string = 'self'): Promise<Response> {
  const body = await req.json() as {
    sourceChannel?: string;
    externalChatId?: string;
  };

  const { sourceChannel, externalChatId } = body;

  if (!sourceChannel || typeof sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  if (!externalChatId || typeof externalChatId !== 'string') {
    return Response.json({ error: 'externalChatId is required' }, { status: 400 });
  }

  // Delete the assistant-scoped key unconditionally. The legacy key is
  // canonical for the self assistant and must not be deleted from non-self
  // routes, otherwise a non-self reset can accidentally reset self state.
  const legacyKey = `${sourceChannel}:${externalChatId}`;
  const scopedKey = `asst:${assistantId}:${sourceChannel}:${externalChatId}`;
  deleteConversationKey(scopedKey);
  if (assistantId === 'self') {
    deleteConversationKey(legacyKey);
  }
  // external_conversation_bindings is currently assistant-agnostic
  // (unique by sourceChannel + externalChatId). Restrict mutations to the
  // canonical self-assistant route so multi-assistant legacy routes do not
  // clobber each other's bindings.
  if (assistantId === 'self') {
    externalConversationStore.deleteBindingByChannelChat(sourceChannel, externalChatId);
  }

  return Response.json({ ok: true });
}
