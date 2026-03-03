/**
 * Outbound A2A message delivery adapter.
 *
 * Handles the full outbound delivery lifecycle: message construction,
 * HMAC-SHA256 request signing, HTTP delivery to the peer's gateway,
 * retry logic for transient failures, and dead-letter notification
 * emission when retries are exhausted.
 *
 * URL validation uses the same canonical rules as a2a-connection-service.ts
 * to ensure HTTPS for public targets and HTTP only for local/private.
 */

import { signRequest } from './a2a-peer-auth.js';
import {
  A2A_EVENT_NAMES,
  type A2AMessageEnvelope,
} from './a2a-message-schema.js';
import { validateA2ATarget } from './a2a-connection-service.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../runtime/assistant-scope.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('a2a-outbound-delivery');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum retry attempts for transient failures. */
export const MAX_RETRIES = 3;

/** Base delay for exponential backoff (milliseconds). */
const BASE_RETRY_DELAY_MS = 500;

/** Maximum delay cap (milliseconds). */
const MAX_RETRY_DELAY_MS = 8_000;

/** HTTP request timeout (milliseconds). */
const DELIVERY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliveryResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: 'target_validation_failed' | 'delivery_failed' | 'signing_failed'; error: string };

export interface DeliveryParams {
  /** The constructed message envelope to deliver. */
  envelope: A2AMessageEnvelope;
  /** The peer's gateway URL (delivery target). */
  peerGatewayUrl: string;
  /** The raw outbound credential for HMAC signing. */
  outboundCredential: string;
  /** The A2A connection ID. */
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number): number {
  // Exponential backoff with jitter: base * 2^attempt + random jitter
  const exponential = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_RETRY_DELAY_MS;
  return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}

/**
 * Returns true for HTTP status codes that indicate a transient failure
 * worth retrying (5xx server errors).
 */
function isTransientHttpError(status: number): boolean {
  return status >= 500 && status < 600;
}

// ---------------------------------------------------------------------------
// Core delivery function (single attempt)
// ---------------------------------------------------------------------------

async function deliverOnce(
  params: DeliveryParams,
): Promise<{ ok: true; status: number } | { ok: false; transient: boolean; error: string; status?: number }> {
  const { envelope, peerGatewayUrl, outboundCredential, connectionId } = params;

  const targetUrl = `${peerGatewayUrl.replace(/\/+$/, '')}/v1/a2a/messages/inbound`;

  const bodyText = JSON.stringify(envelope);

  // Sign the request with HMAC-SHA256
  let headers: Record<string, string>;
  try {
    const signedHeaders = signRequest(connectionId, outboundCredential, bodyText);
    headers = {
      ...signedHeaders,
      'content-type': 'application/json',
    };
  } catch (err) {
    return {
      ok: false,
      transient: false,
      error: `Failed to sign request: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: bodyText,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    const responseText = await response.text().catch(() => '');
    const transient = isTransientHttpError(response.status);

    return {
      ok: false,
      transient,
      error: `HTTP ${response.status}: ${responseText.slice(0, 256)}`,
      status: response.status,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    // Network errors and timeouts are transient
    return {
      ok: false,
      transient: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deliver an A2A message to a peer assistant's gateway with retry logic.
 *
 * Flow:
 * 1. Validate the target URL (same rules as connection service)
 * 2. Sign the request body with HMAC-SHA256
 * 3. POST to {peerGatewayUrl}/v1/a2a/messages/inbound
 * 4. On transient failure (5xx, network error): retry up to MAX_RETRIES
 *    with exponential backoff
 * 5. On permanent failure (4xx) or retries exhausted: emit message_failed
 *    lifecycle event via notification pipeline
 * 6. On success: emit message_delivered lifecycle event
 */
export async function deliverMessage(params: DeliveryParams): Promise<DeliveryResult> {
  const { envelope, peerGatewayUrl, connectionId } = params;

  // Validate target URL before attempting delivery
  const targetValidation = validateA2ATarget(peerGatewayUrl);
  if (!targetValidation.ok) {
    log.warn(
      { connectionId, peerGatewayUrl, reason: targetValidation.reason },
      'Target URL validation failed for outbound A2A message',
    );
    return {
      ok: false,
      reason: 'target_validation_failed',
      error: targetValidation.reason,
    };
  }

  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const retryDelayMs = getRetryDelay(attempt - 1);
      log.info(
        { connectionId, messageId: envelope.messageId, attempt, retryDelayMs },
        'Retrying A2A message delivery',
      );
      await delay(retryDelayMs);
    }

    const result = await deliverOnce(params);

    if (result.ok) {
      log.info(
        { connectionId, messageId: envelope.messageId, status: result.status, attempt },
        'A2A message delivered successfully',
      );

      // Emit message_delivered lifecycle event
      void emitNotificationSignal({
        sourceEventName: A2A_EVENT_NAMES.MESSAGE_DELIVERED,
        sourceChannel: 'a2a',
        sourceSessionId: connectionId,
        assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
        attentionHints: {
          requiresAction: false,
          urgency: 'low',
          isAsyncBackground: true,
          visibleInSourceNow: false,
        },
        contextPayload: {
          connectionId,
          messageId: envelope.messageId,
        },
        dedupeKey: `a2a:message-delivered:${envelope.messageId}`,
      });

      return { ok: true, messageId: envelope.messageId };
    }

    lastError = result.error;

    // Non-transient failure — don't retry
    if (!result.transient) {
      log.warn(
        { connectionId, messageId: envelope.messageId, error: result.error, status: result.status },
        'A2A message delivery failed with permanent error',
      );
      break;
    }

    log.warn(
      { connectionId, messageId: envelope.messageId, error: result.error, attempt, maxRetries: MAX_RETRIES },
      'A2A message delivery failed with transient error',
    );
  }

  // Dead-letter: emit message_failed lifecycle event
  log.error(
    { connectionId, messageId: envelope.messageId, error: lastError },
    'A2A message delivery exhausted retries — dead-lettered',
  );

  void emitNotificationSignal({
    sourceEventName: A2A_EVENT_NAMES.MESSAGE_FAILED,
    sourceChannel: 'a2a',
    sourceSessionId: connectionId,
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    attentionHints: {
      requiresAction: true,
      urgency: 'medium',
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    contextPayload: {
      connectionId,
      messageId: envelope.messageId,
      error: lastError,
    },
    dedupeKey: `a2a:message-failed:${envelope.messageId}`,
  });

  return {
    ok: false,
    reason: 'delivery_failed',
    error: lastError,
  };
}
