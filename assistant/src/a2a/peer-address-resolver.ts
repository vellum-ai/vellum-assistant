/**
 * Provider-agnostic peer address resolution.
 *
 * Abstracts how a peer's A2A gateway address is discovered from a raw input
 * string. V1 uses invite codes; future versions can swap in a directory-backed
 * resolver without changing call sites.
 */

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

export type PeerAddressResolution =
  | { ok: true; peerGatewayUrl: string; inviteToken: string; protocolVersion?: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'not_found' | 'unreachable' | 'invalid_version' };

// ---------------------------------------------------------------------------
// Resolver interface
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic interface for resolving raw discovery input (invite codes,
 * directory lookups, etc.) into a structured peer address.
 *
 * Implementations:
 *   - `InviteBasedResolver` (v1) — decodes base64url invite codes
 *   - Future: directory-backed resolver that queries a peer registry
 */
export interface PeerAddressResolver {
  /** Resolve an invite/discovery input to a peer address. */
  resolve(input: string): Promise<PeerAddressResolution>;
}
