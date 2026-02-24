/**
 * Shared request parsing and validation for HTTP send endpoints
 * (POST /v1/runs and POST /v1/messages).
 *
 * Both endpoints accept the same body shape and apply the same
 * validation rules. This module extracts that logic so each handler
 * only implements the submission/response contract that differs.
 */
import type { ChannelId } from '../../channels/types.js';
import { CHANNEL_IDS, parseChannelId } from '../../channels/types.js';
import { getOrCreateConversation } from '../../memory/conversation-key-store.js';
import * as attachmentsStore from '../../memory/attachments-store.js';

export interface ValidatedSendRequest {
  conversationKey: string;
  conversationId: string;
  content: string;
  attachmentIds: string[] | undefined;
  sourceChannel: ChannelId;
}

/**
 * Parse and validate a send request body.
 * Returns a `ValidatedSendRequest` on success, or a `Response` (4xx) on failure.
 */
export async function parseSendRequest(
  req: Request,
): Promise<ValidatedSendRequest | Response> {
  const body = await req.json() as {
    conversationKey?: string;
    content?: string;
    attachmentIds?: string[];
    sourceChannel?: string;
  };

  const { conversationKey, content, attachmentIds } = body;

  if (!body.sourceChannel || typeof body.sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  const sourceChannel = parseChannelId(body.sourceChannel);
  if (!sourceChannel) {
    return Response.json(
      { error: `Invalid sourceChannel: ${body.sourceChannel}. Valid values: ${CHANNEL_IDS.join(', ')}` },
      { status: 400 },
    );
  }

  if (!conversationKey) {
    return Response.json({ error: 'conversationKey is required' }, { status: 400 });
  }

  if (content != null && typeof content !== 'string') {
    return Response.json({ error: 'content must be a string' }, { status: 400 });
  }

  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments) {
    return Response.json({ error: 'content or attachmentIds is required' }, { status: 400 });
  }

  if (hasAttachments) {
    const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      return Response.json(
        { error: `Attachment IDs not found: ${missing.join(', ')}` },
        { status: 400 },
      );
    }
  }

  const mapping = getOrCreateConversation(conversationKey);

  return {
    conversationKey,
    conversationId: mapping.conversationId,
    content: content ?? '',
    attachmentIds: hasAttachments ? attachmentIds : undefined,
    sourceChannel,
  };
}

/** Type guard: returns true if `parseSendRequest` returned a validation error Response. */
export function isValidationError(result: ValidatedSendRequest | Response): result is Response {
  return result instanceof Response;
}
