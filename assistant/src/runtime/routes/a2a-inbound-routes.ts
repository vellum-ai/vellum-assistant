/**
 * Runtime route handler for inbound A2A messages from peer assistants.
 *
 * Handles message deduplication, connection validation, and routing through
 * the standard inbound message pipeline with peer_assistant trust
 * classification applied from the start.
 *
 * HMAC-SHA256 peer auth verification is expected to be handled at the
 * gateway/proxy level using the A2A auth headers. The runtime validates
 * the connection is active and the envelope is well-formed.
 *
 * The gateway proxies POST /v1/a2a/messages/inbound to this handler.
 */

import {
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_CONNECTION_ID,
} from '../../a2a/a2a-peer-auth.js';
import { getConnection } from '../../a2a/a2a-peer-connection-store.js';
import { defaultMessageDedupStore } from '../../a2a/a2a-message-dedup.js';
import type { A2AMessageEnvelope } from '../../a2a/a2a-message-schema.js';
import { getLogger } from '../../util/logger.js';
import { httpError } from '../http-errors.js';
import type { MessageProcessor } from '../http-types.js';

const log = getLogger('a2a-inbound');

/**
 * Handle an inbound A2A message from a peer assistant.
 *
 * Flow:
 * 1. Parse the A2A message envelope from the request body
 * 2. Validate A2A auth headers are present and connection ID matches
 * 3. Check the connection is active
 * 4. Check message deduplication via (connectionId, nonce)
 * 5. Route through processMessage with peer_assistant trust context
 */
export async function handleA2AMessageInbound(
  req: Request,
  processMessage?: MessageProcessor,
): Promise<Response> {
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return httpError('BAD_REQUEST', 'Failed to read request body', 400);
  }

  let envelope: A2AMessageEnvelope;
  try {
    envelope = JSON.parse(bodyText) as A2AMessageEnvelope;
  } catch {
    return httpError('BAD_REQUEST', 'Invalid JSON', 400);
  }

  // Validate required fields
  if (!envelope.messageId || !envelope.connectionId || !envelope.senderAssistantId) {
    return httpError('BAD_REQUEST', 'Missing required fields: messageId, connectionId, senderAssistantId', 400);
  }

  if (!envelope.content || !envelope.content.type) {
    return httpError('BAD_REQUEST', 'Missing required field: content.type', 400);
  }

  if (!envelope.nonce) {
    return httpError('BAD_REQUEST', 'Missing required field: nonce', 400);
  }

  // Validate A2A auth headers are present
  const hasA2AAuth = !!(
    req.headers.get(HEADER_SIGNATURE) &&
    req.headers.get(HEADER_TIMESTAMP) &&
    req.headers.get(HEADER_NONCE) &&
    req.headers.get(HEADER_CONNECTION_ID)
  );

  if (!hasA2AAuth) {
    return httpError('UNAUTHORIZED', 'Missing A2A authentication headers', 401);
  }

  // Verify the connection ID in the header matches the envelope
  if (req.headers.get(HEADER_CONNECTION_ID) !== envelope.connectionId) {
    return httpError('BAD_REQUEST', 'Connection ID mismatch between header and envelope', 400);
  }

  // Look up and validate the connection
  const connection = getConnection(envelope.connectionId);
  if (!connection) {
    return httpError('NOT_FOUND', 'Connection not found', 404);
  }

  if (connection.status !== 'active') {
    return httpError('FORBIDDEN', 'Connection is not active', 403);
  }

  // Message deduplication: check (connectionId, nonce) before processing
  if (defaultMessageDedupStore.isDuplicate(envelope.connectionId, envelope.nonce)) {
    log.info(
      { connectionId: envelope.connectionId, messageId: envelope.messageId },
      'Duplicate A2A message, returning accepted',
    );
    return Response.json({
      accepted: true,
      duplicate: true,
      messageId: envelope.messageId,
    });
  }

  // Extract text content from the envelope based on content type
  let textContent: string;
  const content = envelope.content;
  switch (content.type) {
    case 'text':
      textContent = content.text;
      break;
    case 'structured_request':
      textContent = JSON.stringify({
        type: 'structured_request',
        action: content.action,
        params: content.params,
      });
      break;
    case 'structured_response':
      textContent = JSON.stringify({
        type: 'structured_response',
        action: content.action,
        result: content.result,
        success: content.success,
        error: content.error,
      });
      break;
    default:
      textContent = '';
  }

  if (!processMessage) {
    return httpError('INTERNAL_ERROR', 'Message processor not available', 500);
  }

  try {
    // Use the connection ID as the conversation ID so messages from the
    // same peer connection are grouped in the same conversation thread.
    // The guardianContext carries peer_assistant trust from the start --
    // there is no window where this message could be processed without
    // proper trust classification.
    const result = await processMessage(
      envelope.connectionId,   // conversationId: use connection ID for conversation grouping
      textContent,
      undefined,               // no attachments
      {
        guardianContext: {
          sourceChannel: 'assistant',
          trustClass: 'peer_assistant',
          requesterExternalUserId: envelope.senderAssistantId,
          requesterChatId: envelope.connectionId,
          requesterIdentifier: envelope.senderAssistantId,
          requesterDisplayName: connection.peerDisplayName ?? envelope.senderAssistantId,
        },
      },
      'assistant',             // sourceChannel
      'assistant',             // sourceInterface
    );

    log.info(
      {
        connectionId: envelope.connectionId,
        messageId: envelope.messageId,
        senderAssistantId: envelope.senderAssistantId,
      },
      'A2A inbound message processed',
    );

    return Response.json({
      accepted: true,
      duplicate: false,
      messageId: envelope.messageId,
    });
  } catch (err) {
    log.error(
      { err, connectionId: envelope.connectionId, messageId: envelope.messageId },
      'Failed to process A2A inbound message',
    );
    return httpError('INTERNAL_ERROR', 'Failed to process message', 500);
  }
}
