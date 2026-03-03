/**
 * HMAC-SHA256 authentication for inbound revocation notifications.
 *
 * Verifies the peer's signature on the revoke-notify request using
 * the stored inbound credential for the connection. This is a simpler
 * flow than full message auth — no dedup, no scope checks, just
 * signature verification.
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

export type RevokeNotifyAuthResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify the HMAC signature on a revocation notification request.
 *
 * Accepts connections in `active` or `revocation_pending` status (the peer
 * may be trying to revoke a connection that we already started revoking).
 * Connections that are already `revoked` or `revoked_by_peer` pass through
 * because the handler treats them as idempotent no-ops.
 */
export function verifyA2ASignatureForConnection(
  req: Request,
  bodyText: string,
  connectionId: string,
): RevokeNotifyAuthResult {
  const signature = req.headers.get(HEADER_SIGNATURE);
  const timestamp = req.headers.get(HEADER_TIMESTAMP);
  const nonce = req.headers.get(HEADER_NONCE);
  const connectionIdHeader = req.headers.get(HEADER_CONNECTION_ID);

  if (!signature || !timestamp || !nonce || !connectionIdHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  if (connectionIdHeader !== connectionId) {
    return { ok: false, reason: 'connection_id_mismatch' };
  }

  const connection = getConnection(connectionId);
  if (!connection) {
    return { ok: false, reason: 'connection_not_found' };
  }

  // For already-revoked connections, we skip signature verification and let
  // the handler return an idempotent success.
  if (connection.status === 'revoked' || connection.status === 'revoked_by_peer') {
    return { ok: true };
  }

  // The inbound credential is needed for HMAC verification. If it's been
  // tombstoned (revocation_pending from our side), skip verification and
  // let the handler decide (it will see already_revoked).
  if (!connection.inboundCredential) {
    if (connection.status === 'revocation_pending') {
      return { ok: true };
    }
    return { ok: false, reason: 'no_credential' };
  }

  const verifyResult = verifySignature({
    signature,
    timestamp,
    nonce,
    body: bodyText,
    credential: connection.inboundCredential,
    nonceStore: defaultNonceStore,
  });

  if (!verifyResult.ok) {
    return { ok: false, reason: verifyResult.reason };
  }

  return { ok: true };
}
