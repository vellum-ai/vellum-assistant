/**
 * A2A Connection Service — surface-agnostic orchestration layer.
 *
 * Single API surface consumed by all interaction surfaces (chat skills,
 * Telegram handlers, Settings UI). Every method is stateless request-in /
 * result-out with no coupling to chat sessions, IPC, or channels.
 *
 * Ties together:
 *   - a2a-peer-connection-store (M2) — connection CRUD
 *   - a2a-handshake (M3) — handshake state machine + crypto
 *   - a2a-peer-auth (M4) — credential generation
 */

import {
  createConnection,
  getConnection,
  listConnections as storeListConnections,
  updateConnectionCredentials,
  updateConnectionStatus,
  type A2APeerConnection,
  type A2APeerConnectionStatus,
} from './a2a-peer-connection-store.js';

import {
  createHandshakeSession,
  generateVerificationCode,
  hashHandshakeSecret,
  INVITE_TOKEN_TTL_MS,
  transitionToAwaitingApproval,
  transitionToAwaitingVerification,
  transitionToVerified,
  transitionToActive,
  type HandshakeSession,
} from './a2a-handshake.js';

import { generateCredentialPair } from './a2a-peer-auth.js';

import {
  createInvite as createIngressInvite,
  findByTokenHash,
  hashToken,
  markInviteExpired,
  recordInviteUse,
} from '../memory/ingress-invite-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** v1 protocol version string. */
export const A2A_PROTOCOL_VERSION = '1.0.0';

/** Source channel discriminator for A2A invites in the ingress invite table. */
export const A2A_SOURCE_CHANNEL = 'assistant';

/** Default invite TTL: 24 hours. */
const DEFAULT_INVITE_TTL_MS = INVITE_TOKEN_TTL_MS;

/** Default runtime HTTP port — used for self-loop and runtime port detection. */
const RUNTIME_PORT = 7821;

/**
 * Return the effective port for a parsed URL — the explicit port if present,
 * otherwise the protocol default (443 for https, 80 for http).
 */
function getEffectivePort(parsed: URL): number {
  if (parsed.port) return parseInt(parsed.port, 10);
  return parsed.protocol === 'https:' ? 443 : 80;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type GenerateInviteResult =
  | { ok: true; inviteCode: string; inviteId: string }
  | { ok: false; reason: 'generation_failed' | 'missing_gateway_url' };

export type RedeemInviteResult =
  | { ok: true; peerGatewayUrl: string; inviteId: string; tokenHash: string }
  | { ok: false; reason: 'invalid_or_expired' | 'already_redeemed' | 'malformed_invite' };

export type InitiateConnectionResult =
  | { ok: true; connectionId: string; handshakeSessionId: string }
  | { ok: false; reason: 'invalid_target' | 'version_mismatch' | 'invite_not_found' | 'invite_consumed'; detail?: string };

export type ApproveConnectionResult =
  | { ok: true; verificationCode: string; connectionId: string }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'already_resolved' };

export type DenyConnectionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'already_resolved' };

export type SubmitVerificationCodeResult =
  | { ok: true; connection: A2APeerConnection }
  | { ok: false; reason: 'not_found' | 'invalid_code' | 'expired' | 'max_attempts' | 'invalid_state' | 'identity_mismatch' };

export type RevokeConnectionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

export type ListConnectionsResult = {
  connections: A2APeerConnection[];
};

// ---------------------------------------------------------------------------
// Invite code encoding/decoding
// ---------------------------------------------------------------------------

interface InvitePayload {
  /** Gateway URL of the inviting assistant. */
  g: string;
  /** One-time token. */
  t: string;
  /** Protocol version. */
  v: string;
}

/**
 * Encode an invite payload into a compact, URL-safe string.
 * Uses base64url encoding of a JSON payload.
 */
export function encodeInviteCode(gatewayUrl: string, token: string): string {
  const payload: InvitePayload = {
    g: gatewayUrl,
    t: token,
    v: A2A_PROTOCOL_VERSION,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decode an invite code back into its payload components.
 * Returns null if the code is malformed or unparseable.
 */
export function decodeInviteCode(inviteCode: string): InvitePayload | null {
  try {
    const json = Buffer.from(inviteCode, 'base64url').toString('utf-8');
    const payload = JSON.parse(json) as Record<string, unknown>;

    if (
      typeof payload.g !== 'string' || !payload.g ||
      typeof payload.t !== 'string' || !payload.t ||
      typeof payload.v !== 'string' || !payload.v
    ) {
      return null;
    }

    return { g: payload.g, t: payload.t, v: payload.v };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Target URL validation
// ---------------------------------------------------------------------------

/**
 * Validate a peer gateway URL for outbound A2A connections. Implements
 * the canonical target validation rule from the architecture doc.
 *
 * Rules:
 *   - Only http:// and https:// schemes allowed
 *   - HTTPS required for public addresses
 *   - HTTP permitted only for local/private addresses (RFC 1918, loopback)
 *   - Always deny: link-local (169.254.x.x, fe80::), runtime port 7821,
 *     self-loop to own gateway
 */
export function validateA2ATarget(
  url: string,
  ownGatewayUrl?: string,
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  // Only HTTP(S) schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Invalid scheme: ${parsed.protocol} — only http: and https: allowed` };
  }

  const hostname = parsed.hostname;
  const port = getEffectivePort(parsed);

  // Deny runtime port on any address
  if (port === RUNTIME_PORT) {
    return { ok: false, reason: `Port ${RUNTIME_PORT} is the daemon runtime port — use the gateway URL instead` };
  }

  // Deny self-loop — compare normalized effective ports so that implicit
  // defaults (e.g. https://host vs https://host:443) are treated as equal.
  if (ownGatewayUrl) {
    try {
      const ownParsed = new URL(ownGatewayUrl);
      if (
        parsed.hostname === ownParsed.hostname &&
        getEffectivePort(parsed) === getEffectivePort(ownParsed) &&
        parsed.protocol === ownParsed.protocol
      ) {
        return { ok: false, reason: 'Cannot connect to own gateway (self-loop)' };
      }
    } catch {
      // If own URL is unparseable, skip self-loop check
    }
  }

  // Check for link-local and metadata addresses
  if (isLinkLocalAddress(hostname)) {
    return { ok: false, reason: `Link-local/metadata address denied: ${hostname}` };
  }

  // HTTP only allowed for local/private addresses
  if (parsed.protocol === 'http:' && !isLocalAddress(hostname)) {
    return { ok: false, reason: 'HTTP is only allowed for local/private addresses — use HTTPS for public targets' };
  }

  return { ok: true };
}

/**
 * Check if a hostname is a link-local or metadata address (always denied).
 * Covers IPv4 169.254.0.0/16 and IPv6 fe80::/10.
 */
function isLinkLocalAddress(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // IPv6 link-local
  if (lower.startsWith('fe80:') || lower.startsWith('[fe80:')) {
    return true;
  }

  // IPv4 link-local (169.254.x.x) — cloud metadata endpoint SSRF vector
  const parts = lower.split('.');
  if (parts.length === 4) {
    const octets = parts.map(Number);
    if (octets.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
      if (octets[0] === 169 && octets[1] === 254) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a hostname is a local/private address where HTTP is permitted.
 * Mirrors the Swift `LocalAddressValidator.isLocalAddress()` logic.
 */
function isLocalAddress(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Loopback and mDNS — WHATWG URL parser returns bracketed hostnames for
  // IPv6 addresses (e.g. new URL('http://[::1]:7830').hostname === '[::1]'),
  // so we check both bare and bracketed forms.
  if (lower === 'localhost' || lower === '::1' || lower === '[::1]' || lower.endsWith('.local')) {
    return true;
  }

  // IPv6 link-local (fe80::) — these are local but we deny them separately
  // in isLinkLocalAddress; included here for completeness
  if (lower.startsWith('fe80:') || lower.startsWith('[fe80:')) {
    return true;
  }

  // IPv4
  const parts = lower.split('.');
  if (parts.length === 4) {
    const octets = parts.map(Number);
    if (octets.every((o) => !isNaN(o) && o >= 0 && o <= 255)) {
      // 127.0.0.0/8 — loopback
      if (octets[0] === 127) return true;
      // 10.0.0.0/8 — private
      if (octets[0] === 10) return true;
      // 172.16.0.0/12 — private
      if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
      // 192.168.0.0/16 — private
      if (octets[0] === 192 && octets[1] === 168) return true;
      // 169.254.0.0/16 — link-local (APIPA)
      if (octets[0] === 169 && octets[1] === 254) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Protocol version check
// ---------------------------------------------------------------------------

/**
 * Check major version compatibility. Returns true if the major versions match.
 */
function isMajorVersionCompatible(our: string, theirs: string): boolean {
  const ourMajor = our.split('.')[0];
  const theirMajor = theirs.split('.')[0];
  return ourMajor === theirMajor;
}

// ---------------------------------------------------------------------------
// In-memory handshake session store
// ---------------------------------------------------------------------------

// Handshake sessions are short-lived (15 min TTL) and don't need persistence.
// They are kept in-memory and keyed by connection ID.
const handshakeSessions = new Map<string, HandshakeSession>();

/** Exposed for testing — clear all in-memory handshake sessions. */
export function _resetHandshakeSessions(): void {
  handshakeSessions.clear();
}

// ---------------------------------------------------------------------------
// Idempotency key store (in-memory, bounded)
// ---------------------------------------------------------------------------

// Maps idempotency keys to invite IDs + codes for generateInvite deduplication.
const idempotencyStore = new Map<string, { inviteId: string; inviteCode: string }>();

/** Exposed for testing — clear idempotency store. */
export function _resetIdempotencyStore(): void {
  idempotencyStore.clear();
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Generate an invite for a peer to connect.
 *
 * Creates a one-time token, hashes it, stores in `assistant_ingress_invites`
 * with `sourceChannel = 'assistant'`. Returns an invite code encoding the
 * gateway URL + token.
 *
 * Idempotent when `idempotencyKey` is provided — returns the same invite
 * if one was already created with that key.
 */
export function generateInvite(params: {
  gatewayUrl: string;
  expiresInMs?: number;
  note?: string;
  idempotencyKey?: string;
}): GenerateInviteResult {
  if (!params.gatewayUrl) {
    return { ok: false, reason: 'missing_gateway_url' };
  }

  // Idempotency: if a key was provided and we've seen it, return the cached result
  if (params.idempotencyKey) {
    const cached = idempotencyStore.get(params.idempotencyKey);
    if (cached) {
      return { ok: true, inviteCode: cached.inviteCode, inviteId: cached.inviteId };
    }
  }

  try {
    const { invite, rawToken } = createIngressInvite({
      sourceChannel: A2A_SOURCE_CHANNEL,
      note: params.note,
      expiresInMs: params.expiresInMs ?? DEFAULT_INVITE_TTL_MS,
      maxUses: 1,
    });

    const inviteCode = encodeInviteCode(params.gatewayUrl, rawToken);

    // Cache for idempotency
    if (params.idempotencyKey) {
      idempotencyStore.set(params.idempotencyKey, {
        inviteId: invite.id,
        inviteCode,
      });
    }

    return { ok: true, inviteCode, inviteId: invite.id };
  } catch {
    return { ok: false, reason: 'generation_failed' };
  }
}

/**
 * Decode and validate an invite code.
 *
 * Parses the invite, validates the token hash against the store, checks
 * expiry. Does NOT initiate a connection — that is a separate step.
 */
export function redeemInvite(params: {
  inviteCode: string;
}): RedeemInviteResult {
  const payload = decodeInviteCode(params.inviteCode);
  if (!payload) {
    return { ok: false, reason: 'malformed_invite' };
  }

  const tokenH = hashToken(payload.t);
  const invite = findByTokenHash(tokenH);

  if (!invite) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  // Check channel — must be an A2A invite
  if (invite.sourceChannel !== A2A_SOURCE_CHANNEL) {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  // Check expiry
  if (invite.expiresAt <= Date.now()) {
    markInviteExpired(invite.id);
    return { ok: false, reason: 'invalid_or_expired' };
  }

  // Check status
  if (invite.status === 'redeemed') {
    return { ok: false, reason: 'already_redeemed' };
  }

  if (invite.status !== 'active') {
    return { ok: false, reason: 'invalid_or_expired' };
  }

  return {
    ok: true,
    peerGatewayUrl: payload.g,
    inviteId: invite.id,
    tokenHash: tokenH,
  };
}

/**
 * Initiate a connection request to a peer.
 *
 * Validates the peer URL, checks protocol version, consumes the invite,
 * creates a pending connection, and initializes a handshake session.
 */
export function initiateConnection(params: {
  peerGatewayUrl: string;
  peerAssistantId?: string;
  inviteToken: string;
  protocolVersion: string;
  capabilities: string[];
  ownGatewayUrl?: string;
}): InitiateConnectionResult {
  // Validate target URL
  const targetValidation = validateA2ATarget(params.peerGatewayUrl, params.ownGatewayUrl);
  if (!targetValidation.ok) {
    return { ok: false, reason: 'invalid_target', detail: targetValidation.reason };
  }

  // Protocol version check
  if (!isMajorVersionCompatible(A2A_PROTOCOL_VERSION, params.protocolVersion)) {
    return {
      ok: false,
      reason: 'version_mismatch',
      detail: `Expected major version ${A2A_PROTOCOL_VERSION.split('.')[0]}, got ${params.protocolVersion.split('.')[0]}`,
    };
  }

  // Validate invite token against store
  const tokenH = hashToken(params.inviteToken);
  const invite = findByTokenHash(tokenH);

  if (!invite) {
    return { ok: false, reason: 'invite_not_found' };
  }

  // Must be an A2A invite — reject tokens created for other ingress flows
  if (invite.sourceChannel !== A2A_SOURCE_CHANNEL) {
    return { ok: false, reason: 'invite_not_found' };
  }

  if (invite.status === 'redeemed') {
    return { ok: false, reason: 'invite_consumed' };
  }

  if (invite.status !== 'active' || invite.expiresAt <= Date.now()) {
    return { ok: false, reason: 'invite_not_found' };
  }

  // Consume the invite
  const consumed = recordInviteUse({ inviteId: invite.id });
  if (!consumed) {
    return { ok: false, reason: 'invite_consumed' };
  }

  // Create pending connection
  const connection = createConnection({
    peerGatewayUrl: params.peerGatewayUrl,
    peerAssistantId: params.peerAssistantId,
    inviteId: invite.id,
    status: 'pending',
    protocolVersion: params.protocolVersion,
    capabilities: params.capabilities,
  });

  // Create handshake session and bind to connection
  const inviteTokenHash = hashHandshakeSecret(params.inviteToken);
  const session = createHandshakeSession({ inviteTokenHash });
  handshakeSessions.set(connection.id, session);

  return {
    ok: true,
    connectionId: connection.id,
    handshakeSessionId: session.id,
  };
}

/**
 * Approve or deny a pending connection request.
 *
 * On approve: generates a verification code, transitions handshake to
 * `awaiting_verification`, and returns the code for guardian to share IRL.
 *
 * On deny: transitions the connection to `revoked`.
 */
export function approveConnection(params: {
  connectionId: string;
  decision: 'approve' | 'deny';
}): ApproveConnectionResult | DenyConnectionResult {
  const connection = getConnection(params.connectionId);
  if (!connection) {
    return { ok: false, reason: 'not_found' };
  }

  if (connection.status !== 'pending') {
    if (connection.status === 'active' || connection.status === 'revoked') {
      return { ok: false, reason: 'already_resolved' };
    }
    return { ok: false, reason: 'invalid_state' };
  }

  if (params.decision === 'deny') {
    const updated = updateConnectionStatus(params.connectionId, 'revoked', 'pending');
    if (!updated) {
      return { ok: false, reason: 'already_resolved' };
    }
    // Clean up handshake session
    handshakeSessions.delete(params.connectionId);
    return { ok: true };
  }

  // Approve flow
  const session = handshakeSessions.get(params.connectionId);
  if (!session) {
    return { ok: false, reason: 'not_found' };
  }

  // Bind the peer's authenticated identity — peerAssistantId when available,
  // otherwise peerGatewayUrl. Using connectionId would be meaningless because
  // it is a generated UUID returned to the requester, so any caller who knows
  // the ID could satisfy the anti-hijack check by echoing it back.
  const peerIdentity = connection.peerAssistantId ?? connection.peerGatewayUrl;

  // Transition handshake: awaiting_request -> awaiting_approval
  const toApproval = transitionToAwaitingApproval(session, peerIdentity);
  if (!toApproval.ok) {
    return { ok: false, reason: 'invalid_state' };
  }

  // Generate verification code
  const verificationCode = generateVerificationCode();
  const codeHash = hashHandshakeSecret(verificationCode);

  // Transition handshake: awaiting_approval -> awaiting_verification
  const toVerification = transitionToAwaitingVerification(toApproval.session, codeHash);
  if (!toVerification.ok) {
    return { ok: false, reason: 'invalid_state' };
  }

  // Save updated session
  handshakeSessions.set(params.connectionId, toVerification.session);

  return {
    ok: true,
    verificationCode,
    connectionId: params.connectionId,
  };
}

/**
 * Submit the IRL verification code for a pending connection.
 *
 * Validates the code via handshake primitives. On success, generates
 * credentials and transitions to `active`.
 */
export function submitVerificationCode(params: {
  connectionId: string;
  code: string;
  peerIdentity: string;
}): SubmitVerificationCodeResult {
  const connection = getConnection(params.connectionId);
  if (!connection) {
    return { ok: false, reason: 'not_found' };
  }

  if (connection.status === 'active') {
    return { ok: false, reason: 'invalid_state' };
  }

  if (connection.status === 'revoked' || connection.status === 'revoked_by_peer') {
    return { ok: false, reason: 'invalid_state' };
  }

  const session = handshakeSessions.get(params.connectionId);
  if (!session) {
    return { ok: false, reason: 'not_found' };
  }

  if (session.state !== 'awaiting_verification') {
    return { ok: false, reason: 'invalid_state' };
  }

  // Verify the code via handshake state machine — the identity check inside
  // transitionToVerified compares the caller's peerIdentity against what
  // transitionToAwaitingApproval bound (peerAssistantId or peerGatewayUrl).
  const codeHash = hashHandshakeSecret(params.code);
  const result = transitionToVerified(session, codeHash, params.peerIdentity);

  if (!result.ok) {
    // Update session state on failure (e.g. increment attempt count)
    if (result.reason === 'invalid_code' && 'session' in result) {
      handshakeSessions.set(params.connectionId, result.session);
    }

    // Map handshake transition reasons to service-level reasons
    type FailureReason = Extract<SubmitVerificationCodeResult, { ok: false }>['reason'];
    const reasonMap: Record<string, FailureReason> = {
      invalid_transition: 'invalid_state',
      expired: 'expired',
      identity_mismatch: 'identity_mismatch',
      max_attempts: 'max_attempts',
      invalid_code: 'invalid_code',
    };

    return { ok: false as const, reason: reasonMap[result.reason] ?? ('invalid_state' as FailureReason) };
  }

  // Transition to active
  const activeResult = transitionToActive(result.session);
  if (!activeResult.ok) {
    return { ok: false, reason: 'invalid_state' };
  }

  // CAS transition to active FIRST — if another caller resolved/revoked the
  // connection between verification and now, this fails and we avoid writing
  // credentials to a non-active connection.
  const updatedConnection = updateConnectionStatus(params.connectionId, 'active', 'pending');
  if (!updatedConnection) {
    return { ok: false, reason: 'invalid_state' };
  }

  // Generate and persist credentials only after successful status transition
  const credentials = generateCredentialPair();

  const connectionWithCredentials = updateConnectionCredentials(params.connectionId, {
    outboundCredentialHash: credentials.outboundCredentialHash,
    inboundCredentialHash: credentials.inboundCredentialHash,
  });

  // Clean up handshake session — connection is now active
  handshakeSessions.delete(params.connectionId);

  return { ok: true, connection: connectionWithCredentials ?? updatedConnection };
}

/**
 * Revoke an active connection.
 *
 * Idempotent: revoking an already-revoked connection returns `{ ok: true }`.
 * Tombstones credentials and updates status.
 */
export function revokeConnection(params: {
  connectionId: string;
}): RevokeConnectionResult {
  const connection = getConnection(params.connectionId);
  if (!connection) {
    return { ok: false, reason: 'not_found' };
  }

  // Idempotent: already revoked is a success
  if (connection.status === 'revoked' || connection.status === 'revoked_by_peer') {
    return { ok: true };
  }

  // Tombstone credentials
  updateConnectionCredentials(params.connectionId, {
    outboundCredentialHash: '',
    inboundCredentialHash: '',
  });

  // Transition to revoked
  updateConnectionStatus(params.connectionId, 'revoked');

  // Clean up any lingering handshake session
  handshakeSessions.delete(params.connectionId);

  return { ok: true };
}

/**
 * List connections with optional status filter.
 * Always succeeds — returns empty array when no connections exist.
 */
export function listConnectionsFiltered(params?: {
  status?: A2APeerConnectionStatus;
}): ListConnectionsResult {
  const connections = storeListConnections({
    status: params?.status,
  });
  return { connections };
}
