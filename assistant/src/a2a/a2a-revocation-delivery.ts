/**
 * Outbound revocation notification delivery for A2A connections.
 *
 * Sends a signed revocation notification to a peer's gateway so the
 * remote side can tombstone credentials and block further communication.
 * Uses the same HMAC-SHA256 signing as regular A2A message delivery.
 *
 * Separated from `a2a-outbound-delivery.ts` because the revocation
 * notification is a lifecycle control-plane message, not a regular
 * data-plane message, and targets a different endpoint
 * (`/v1/a2a/revoke-notify` instead of `/v1/a2a/messages/inbound`).
 */

import { signRequest } from './a2a-peer-auth.js';
import { validateA2ATarget } from './a2a-connection-service.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('a2a-revocation-delivery');

/** HTTP request timeout for revocation notifications (milliseconds). */
const DELIVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RevocationDeliveryResult =
  | { ok: true }
  | { ok: false; reason: 'target_validation_failed' | 'delivery_failed' | 'signing_failed' | 'no_credential'; error: string };

export interface RevocationDeliveryParams {
  /** The A2A connection ID being revoked. */
  connectionId: string;
  /** The peer's gateway URL. */
  peerGatewayUrl: string;
  /** The raw outbound credential for HMAC signing (must be captured before tombstoning). */
  outboundCredential: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a revocation notification to a peer assistant's gateway.
 *
 * Single-attempt delivery (no retry — the caller handles retry via
 * revocation_pending status and sweep timer).
 *
 * Flow:
 * 1. Validate the target URL
 * 2. Sign the request body with HMAC-SHA256 using the outbound credential
 * 3. POST to {peerGatewayUrl}/v1/a2a/revoke-notify
 * 4. Return success/failure
 */
export async function deliverRevocationNotification(
  params: RevocationDeliveryParams,
): Promise<RevocationDeliveryResult> {
  const { connectionId, peerGatewayUrl, outboundCredential } = params;

  if (!outboundCredential) {
    return { ok: false, reason: 'no_credential', error: 'No outbound credential for signing' };
  }

  // Validate target URL
  const targetValidation = validateA2ATarget(peerGatewayUrl);
  if (!targetValidation.ok) {
    log.warn(
      { connectionId, peerGatewayUrl, reason: targetValidation.reason },
      'Target URL validation failed for revocation notification',
    );
    return { ok: false, reason: 'target_validation_failed', error: targetValidation.reason };
  }

  const targetUrl = `${peerGatewayUrl.replace(/\/+$/, '')}/v1/a2a/revoke-notify`;
  const body = JSON.stringify({ connectionId });

  // Sign the request
  let headers: Record<string, string>;
  try {
    const signedHeaders = signRequest(connectionId, outboundCredential, body);
    headers = {
      ...signedHeaders,
      'content-type': 'application/json',
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'signing_failed',
      error: `Failed to sign revocation request: ${err instanceof Error ? err.message : String(err)}`,
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
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      log.info({ connectionId }, 'Revocation notification delivered successfully');
      return { ok: true };
    }

    const responseText = await response.text().catch(() => '');
    log.warn(
      { connectionId, status: response.status, body: responseText.slice(0, 256) },
      'Revocation notification delivery failed',
    );
    return {
      ok: false,
      reason: 'delivery_failed',
      error: `HTTP ${response.status}: ${responseText.slice(0, 256)}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    log.warn(
      { connectionId, err: err instanceof Error ? err.message : String(err) },
      'Revocation notification delivery failed (network error)',
    );
    return {
      ok: false,
      reason: 'delivery_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
