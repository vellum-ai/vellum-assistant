/**
 * Invite-based implementation of PeerAddressResolver.
 *
 * Parses base64url-encoded invite codes containing a peer gateway URL,
 * one-time token, and protocol version. Validates the decoded payload
 * (required fields, URL format, version compatibility) and returns a
 * structured result that callers can use to initiate a connection.
 *
 * Does NOT consume the invite or interact with the invite store — resolution
 * is a read-only operation. Invite consumption happens downstream when the
 * caller calls `initiateConnection()`.
 */

import { A2A_PROTOCOL_VERSION, decodeInviteCode, validateA2ATarget } from './a2a-connection-service.js';
import type { PeerAddressResolution, PeerAddressResolver } from './peer-address-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Major-version compatibility check. Returns true when both versions share
 * the same major version number (e.g. 1.0.0 and 1.2.3 are compatible).
 */
function isMajorVersionCompatible(ours: string, theirs: string): boolean {
  const ourMajor = ours.split('.')[0];
  const theirMajor = theirs.split('.')[0];
  return ourMajor === theirMajor;
}

// ---------------------------------------------------------------------------
// InviteBasedResolver
// ---------------------------------------------------------------------------

export interface InviteBasedResolverOptions {
  /** Own gateway URL — used to reject self-loop connections. */
  ownGatewayUrl?: string;
}

export class InviteBasedResolver implements PeerAddressResolver {
  private readonly ownGatewayUrl: string | undefined;

  constructor(options?: InviteBasedResolverOptions) {
    this.ownGatewayUrl = options?.ownGatewayUrl;
  }

  async resolve(input: string): Promise<PeerAddressResolution> {
    // Strip surrounding whitespace — common when pasting invite codes
    const trimmed = input.trim();
    if (!trimmed) {
      return { ok: false, reason: 'malformed' };
    }

    // Decode the base64url invite payload
    const payload = decodeInviteCode(trimmed);
    if (!payload) {
      return { ok: false, reason: 'malformed' };
    }

    // Validate protocol version compatibility
    if (!isMajorVersionCompatible(A2A_PROTOCOL_VERSION, payload.v)) {
      return { ok: false, reason: 'invalid_version' };
    }

    // Validate the peer gateway URL (scheme, address class, self-loop, etc.)
    const targetCheck = validateA2ATarget(payload.g, this.ownGatewayUrl);
    if (!targetCheck.ok) {
      return { ok: false, reason: 'unreachable' };
    }

    return {
      ok: true,
      peerGatewayUrl: payload.g,
      inviteToken: payload.t,
      protocolVersion: payload.v,
    };
  }
}
