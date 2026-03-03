/**
 * Normalize an A2A message envelope into a GatewayInboundEvent.
 *
 * Maps:
 *   - conversationExternalId -> connectionId (peer connection ID)
 *   - actorExternalId -> senderAssistantId (peer assistant's identifier)
 *   - sourceChannel -> 'assistant'
 *
 * Returns null if the envelope is missing required fields.
 */

import type { GatewayInboundEvent } from '../types.js';

export interface A2AInboundEnvelope {
  messageId: string;
  connectionId: string;
  senderAssistantId: string;
  nonce: string;
  timestamp: number;
  content: {
    type: string;
    text?: string;
    action?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    success?: boolean;
    error?: string;
  };
  delivery?: {
    correlationId?: string;
    replyTo?: string;
  };
  status: string;
}

/**
 * Normalize an A2A message envelope into a GatewayInboundEvent for the
 * assistant channel. Returns null when required fields are missing.
 */
export function normalizeA2AInbound(
  envelope: A2AInboundEnvelope,
): GatewayInboundEvent | null {
  if (!envelope.messageId || !envelope.connectionId || !envelope.senderAssistantId) {
    return null;
  }

  if (!envelope.content) {
    return null;
  }

  // Extract text content from the envelope based on content type
  let textContent: string;
  switch (envelope.content.type) {
    case 'text':
      textContent = envelope.content.text ?? '';
      break;
    case 'structured_request':
      textContent = JSON.stringify({
        type: 'structured_request',
        action: envelope.content.action,
        params: envelope.content.params,
      });
      break;
    case 'structured_response':
      textContent = JSON.stringify({
        type: 'structured_response',
        action: envelope.content.action,
        result: envelope.content.result,
        success: envelope.content.success,
        error: envelope.content.error,
      });
      break;
    default:
      textContent = '';
  }

  return {
    version: 'v1',
    sourceChannel: 'assistant',
    receivedAt: new Date(envelope.timestamp).toISOString(),
    message: {
      content: textContent,
      conversationExternalId: envelope.connectionId,
      externalMessageId: envelope.messageId,
    },
    actor: {
      actorExternalId: envelope.senderAssistantId,
      displayName: envelope.senderAssistantId,
    },
    source: {
      updateId: envelope.nonce,
      messageId: envelope.messageId,
    },
    raw: envelope as unknown as Record<string, unknown>,
  };
}
