/**
 * Runtime route handler for inbound A2A messages from peer assistants.
 *
 * Handles HMAC-SHA256 peer auth verification, message deduplication,
 * connection validation, and routing through the standard inbound message
 * pipeline with peer_assistant trust classification applied from the start.
 *
 * The gateway proxies POST /v1/a2a/messages/inbound to this handler,
 * forwarding the A2A auth headers. The runtime performs the actual HMAC
 * signature verification against the connection's stored inbound credential.
 */

import {
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  HEADER_NONCE,
  HEADER_CONNECTION_ID,
  verifySignature,
  defaultNonceStore,
} from '../../a2a/a2a-peer-auth.js';
import { getConnection } from '../../a2a/a2a-peer-connection-store.js';
import { evaluateScope, type A2AScopedAction } from '../../a2a/a2a-scope-policy.js';
import { isAssistantFeatureFlagEnabled } from '../../config/assistant-feature-flags.js';
import { getConfig } from '../../config/loader.js';
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
 * 3. Look up the connection and verify it is active
 * 4. Verify the HMAC-SHA256 signature against the stored inbound credential
 * 5. Check message deduplication via (connectionId, nonce)
 * 6. Route through processMessage with peer_assistant trust context
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
  const signature = req.headers.get(HEADER_SIGNATURE);
  const timestamp = req.headers.get(HEADER_TIMESTAMP);
  const nonce = req.headers.get(HEADER_NONCE);
  const connectionIdHeader = req.headers.get(HEADER_CONNECTION_ID);

  if (!signature || !timestamp || !nonce || !connectionIdHeader) {
    return httpError('UNAUTHORIZED', 'Missing A2A authentication headers', 401);
  }

  // Verify the connection ID in the header matches the envelope
  if (connectionIdHeader !== envelope.connectionId) {
    return httpError('BAD_REQUEST', 'Connection ID mismatch between header and envelope', 400);
  }

  // Look up and validate the connection
  const connection = getConnection(envelope.connectionId);
  if (!connection) {
    return httpError('NOT_FOUND', 'Connection not found', 404);
  }

  if (connection.status === 'revoked' || connection.status === 'revoked_by_peer' || connection.status === 'revocation_pending') {
    log.warn(
      { connectionId: envelope.connectionId, status: connection.status },
      'Rejecting inbound A2A message from revoked connection',
    );
    return httpError('FORBIDDEN', 'Connection has been revoked', 403);
  }

  if (connection.status !== 'active') {
    return httpError('FORBIDDEN', 'Connection is not active', 403);
  }

  // The raw inbound credential is required for HMAC verification.
  // It is stored alongside the hash when credentials are generated during
  // the handshake (submitVerificationCode) or rotation (rotateCredentials).
  if (!connection.inboundCredential) {
    log.error(
      { connectionId: envelope.connectionId },
      'Connection is active but has no stored inbound credential for HMAC verification',
    );
    return httpError('INTERNAL_ERROR', 'Connection credential not available', 500);
  }

  // Verify the HMAC-SHA256 signature using the stored inbound credential.
  // This checks timestamp freshness, nonce replay, and signature correctness.
  const verifyResult = verifySignature({
    signature,
    timestamp,
    nonce,
    body: bodyText,
    credential: connection.inboundCredential,
    nonceStore: defaultNonceStore,
  });

  if (!verifyResult.ok) {
    log.warn(
      { connectionId: envelope.connectionId, reason: verifyResult.reason },
      'A2A inbound message failed HMAC verification',
    );
    if (verifyResult.reason === 'timestamp_expired') {
      return httpError('UNAUTHORIZED', 'Request timestamp outside replay window', 401);
    }
    if (verifyResult.reason === 'nonce_replayed') {
      return httpError('UNAUTHORIZED', 'Nonce has already been used', 401);
    }
    return httpError('UNAUTHORIZED', 'Invalid signature', 401);
  }

  // Scope check: when the a2a-scope-policy feature flag is active, verify the
  // connection has the required scope for the inbound content type. When the
  // flag is off, allow all inbound messages (backwards compatible).
  const config = getConfig();
  const scopePolicyActive = isAssistantFeatureFlagEnabled('feature_flags.a2a-scope-policy.enabled', config);

  if (scopePolicyActive) {
    // Map content type to the scoped action for evaluation
    const scopedAction: A2AScopedAction = envelope.content.type === 'structured_request'
      ? 'executeRequest'
      : 'receiveMessage';

    const scopeCheck = evaluateScope(connection.scopes, scopedAction);
    if (!scopeCheck.allowed) {
      log.warn(
        {
          connectionId: envelope.connectionId,
          messageId: envelope.messageId,
          action: scopedAction,
          reason: scopeCheck.reason,
        },
        'A2A inbound message denied by scope policy',
      );
      return httpError('FORBIDDEN', `Scope not granted: ${scopeCheck.reason}`, 403);
    }
  }

  // Message deduplication: check-only (don't record yet — record after successful processing
  // so that transient failures allow the peer to retry delivery)
  if (defaultMessageDedupStore.isKnown(envelope.connectionId, envelope.nonce)) {
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
      textContent = content.text ?? '';
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

    // Record the nonce only after successful processing so transient failures
    // don't permanently mark the message as "seen" (allowing peer retries).
    defaultMessageDedupStore.record(envelope.connectionId, envelope.nonce);

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
