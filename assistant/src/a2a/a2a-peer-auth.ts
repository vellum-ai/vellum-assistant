/**
 * A2A peer authentication primitives.
 *
 * Provides credential generation, HMAC-SHA256 request signing/verification,
 * replay protection (timestamp window + nonce tracking), and credential
 * rotation/revocation for peer-to-peer assistant communication.
 *
 * Intentionally independent of the runtime bearer token used for local
 * client auth -- A2A connections use their own credential model as described
 * in the architecture doc (section "4. Peer Identity & Auth Model").
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { hashHandshakeSecret, timingSafeCompare } from './a2a-handshake.js';
import {
  getConnection,
  updateConnectionCredentials,
  updateConnectionStatus,
  type A2APeerConnection,
} from './a2a-peer-connection-store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Credential token length in bytes (32 bytes = 64 hex chars). */
export const CREDENTIAL_BYTE_LENGTH = 32;

/** Default replay window: requests with timestamps older than this are rejected. */
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** HMAC algorithm used for request signing. */
export const HMAC_ALGORITHM = 'sha256';

/** Header names for signed request metadata. */
export const HEADER_SIGNATURE = 'x-a2a-signature';
export const HEADER_TIMESTAMP = 'x-a2a-timestamp';
export const HEADER_NONCE = 'x-a2a-nonce';
export const HEADER_CONNECTION_ID = 'x-a2a-connection-id';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialPair {
  /** Raw credential token we give to the peer (they use it to auth to us). */
  inboundCredential: string;
  /** SHA-256 hash of inboundCredential (what we store). */
  inboundCredentialHash: string;
  /** Raw credential token the peer gives us (we use it to auth to them). */
  outboundCredential: string;
  /** SHA-256 hash of outboundCredential (what we store). */
  outboundCredentialHash: string;
}

export interface SignedRequestHeaders {
  [HEADER_SIGNATURE]: string;
  [HEADER_TIMESTAMP]: string;
  [HEADER_NONCE]: string;
  [HEADER_CONNECTION_ID]: string;
}

export type VerifyResult =
  | { ok: true; connectionId: string }
  | { ok: false; reason: 'missing_headers' | 'connection_not_found' | 'connection_not_active' | 'invalid_signature' | 'timestamp_expired' | 'nonce_replayed' | 'credential_revoked' | 'credential_mismatch' };

export type RotateResult =
  | { ok: true; newCredentials: CredentialPair; connection: A2APeerConnection }
  | { ok: false; reason: 'connection_not_found' | 'connection_not_active' };

export type RevokeResult =
  | { ok: true; connection: A2APeerConnection }
  | { ok: false; reason: 'connection_not_found' | 'already_revoked' };

// ---------------------------------------------------------------------------
// Credential generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure credential token.
 * Returns a hex-encoded random string of `CREDENTIAL_BYTE_LENGTH` bytes.
 */
export function generateCredentialToken(): string {
  return randomBytes(CREDENTIAL_BYTE_LENGTH).toString('hex');
}

/**
 * Generate a full credential pair for a new peer connection.
 * Returns both raw tokens (to exchange with the peer) and their hashes
 * (what gets persisted in the connection store).
 */
export function generateCredentialPair(): CredentialPair {
  const inboundCredential = generateCredentialToken();
  const outboundCredential = generateCredentialToken();

  return {
    inboundCredential,
    inboundCredentialHash: hashHandshakeSecret(inboundCredential),
    outboundCredential,
    outboundCredentialHash: hashHandshakeSecret(outboundCredential),
  };
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 request signing
// ---------------------------------------------------------------------------

/**
 * Construct the canonical string that gets signed.
 * Format: `${timestamp}:${nonce}:${body}`
 *
 * The ordering is deterministic -- timestamp and nonce come first so the
 * verifier can reject expired/replayed requests before touching the body.
 */
export function buildSigningPayload(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}:${nonce}:${body}`;
}

/**
 * Compute an HMAC-SHA256 signature over the given payload using the
 * provided credential as the key.
 */
export function computeHmac(credential: string, payload: string): string {
  return createHmac(HMAC_ALGORITHM, credential).update(payload).digest('hex');
}

/**
 * Sign an outbound request. Returns headers that must be attached to the
 * HTTP request for the peer to verify authenticity.
 *
 * @param connectionId - The A2A connection ID this request belongs to.
 * @param outboundCredential - The raw credential token for signing (our outbound credential).
 * @param body - The serialized request body.
 * @param now - Optional timestamp override for testing.
 */
export function signRequest(
  connectionId: string,
  outboundCredential: string,
  body: string,
  now?: number,
): SignedRequestHeaders {
  const timestamp = String(now ?? Date.now());
  const nonce = randomUUID();
  const payload = buildSigningPayload(timestamp, nonce, body);
  const signature = computeHmac(outboundCredential, payload);

  return {
    [HEADER_SIGNATURE]: signature,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_CONNECTION_ID]: connectionId,
  };
}

// ---------------------------------------------------------------------------
// Nonce store (in-memory, TTL-based cleanup)
// ---------------------------------------------------------------------------

/**
 * In-memory nonce store for replay protection. Tracks seen nonces with
 * their timestamps. Nonces older than the replay window are periodically
 * evicted.
 *
 * Exported as a class so tests can create isolated instances. The module
 * also exports a default singleton for production use.
 */
export class NonceStore {
  private readonly seen = new Map<string, number>();
  private readonly replayWindowMs: number;
  private lastSweep: number;

  constructor(replayWindowMs: number = DEFAULT_REPLAY_WINDOW_MS) {
    this.replayWindowMs = replayWindowMs;
    this.lastSweep = 0;
  }

  /**
   * Check whether a nonce is already tracked (read-only, no side effects).
   * Use this before HMAC verification to avoid polluting the store with
   * unauthenticated nonces.
   */
  isKnown(nonce: string, now?: number): boolean {
    const currentTime = now ?? Date.now();

    // Opportunistic sweep: clean up every replay window interval
    if (currentTime - this.lastSweep >= this.replayWindowMs) {
      this.sweep(currentTime);
    }

    return this.seen.has(nonce);
  }

  /**
   * Record a nonce after the request has been authenticated. Call this
   * only after HMAC verification succeeds to prevent unauthenticated
   * requests from polluting the nonce store.
   */
  record(nonce: string, now?: number): void {
    const currentTime = now ?? Date.now();
    this.seen.set(nonce, currentTime);
  }

  /**
   * Check if a nonce has been seen. If not, record it and return false.
   * If it has been seen (replay), return true.
   *
   * Also performs opportunistic sweep of expired nonces.
   *
   * @deprecated Use `isKnown()` + `record()` instead to avoid polluting
   * the store with unauthenticated nonces.
   */
  hasBeenSeen(nonce: string, now?: number): boolean {
    const currentTime = now ?? Date.now();

    // Opportunistic sweep: clean up every replay window interval
    if (currentTime - this.lastSweep >= this.replayWindowMs) {
      this.sweep(currentTime);
    }

    if (this.seen.has(nonce)) {
      return true;
    }

    this.seen.set(nonce, currentTime);
    return false;
  }

  /**
   * Evict nonces older than the replay window.
   */
  sweep(now?: number): number {
    const currentTime = now ?? Date.now();
    const cutoff = currentTime - this.replayWindowMs;
    let evicted = 0;

    for (const [nonce, timestamp] of this.seen) {
      if (timestamp < cutoff) {
        this.seen.delete(nonce);
        evicted++;
      }
    }

    this.lastSweep = currentTime;
    return evicted;
  }

  /** Current number of tracked nonces. */
  get size(): number {
    return this.seen.size;
  }

  /** Reset the store (for testing). */
  clear(): void {
    this.seen.clear();
  }
}

/** Default singleton nonce store for production use. */
export const defaultNonceStore = new NonceStore();

// ---------------------------------------------------------------------------
// Request verification
// ---------------------------------------------------------------------------

export interface VerifyRequestParams {
  headers: Record<string, string | undefined>;
  body: string;
  nonceStore?: NonceStore;
  replayWindowMs?: number;
  now?: number;
}

/**
 * Verify an inbound request from a peer assistant.
 *
 * Checks (in order):
 * 1. Required headers are present.
 * 2. The connection exists and is active.
 * 3. The caller-supplied inbound credential matches the connection's stored hash.
 * 4. The timestamp is within the replay window.
 * 5. The nonce has not been seen before.
 * 6. The HMAC signature matches.
 *
 * The connection store persists both the raw `inboundCredential` and its
 * SHA-256 hash (`inboundCredentialHash`). The hash is used for
 * identification/revocation checks; the raw credential is the HMAC key
 * used for signature verification.
 *
 * This function accepts the raw inbound credential as a parameter so it
 * can validate (step 3) that the caller-supplied credential matches the
 * stored hash before using it for HMAC verification (step 6).
 *
 * For simpler verification where the caller has already resolved the
 * connection and credential, use `verifySignature()` instead.
 */
export function verifyRequest(
  params: VerifyRequestParams & { inboundCredential: string },
): VerifyResult {
  const { headers, body, inboundCredential, now } = params;
  const nonceStore = params.nonceStore ?? defaultNonceStore;
  const replayWindowMs = params.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const currentTime = now ?? Date.now();

  // 1. Check required headers
  const signature = headers[HEADER_SIGNATURE];
  const timestamp = headers[HEADER_TIMESTAMP];
  const nonce = headers[HEADER_NONCE];
  const connectionId = headers[HEADER_CONNECTION_ID];

  if (!signature || !timestamp || !nonce || !connectionId) {
    return { ok: false, reason: 'missing_headers' };
  }

  // 2. Check connection exists and is active
  const connection = getConnection(connectionId);
  if (!connection) {
    return { ok: false, reason: 'connection_not_found' };
  }

  if (connection.status === 'revoked' || connection.status === 'revoked_by_peer') {
    return { ok: false, reason: 'credential_revoked' };
  }

  if (connection.status !== 'active') {
    return { ok: false, reason: 'connection_not_active' };
  }

  // 3. Validate the caller-supplied credential matches the stored hash
  const inboundCredentialHash = hashHandshakeSecret(inboundCredential);
  if (!connection.inboundCredentialHash || !timingSafeCompare(inboundCredentialHash, connection.inboundCredentialHash)) {
    return { ok: false, reason: 'credential_mismatch' };
  }

  // 4. Check timestamp within replay window
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime) || Math.abs(currentTime - requestTime) > replayWindowMs) {
    return { ok: false, reason: 'timestamp_expired' };
  }

  // 5. Check nonce not replayed (read-only check before HMAC)
  if (nonceStore.isKnown(nonce, currentTime)) {
    return { ok: false, reason: 'nonce_replayed' };
  }

  // 6. Verify HMAC signature
  const payload = buildSigningPayload(timestamp, nonce, body);
  const expectedSignature = computeHmac(inboundCredential, payload);

  if (!timingSafeCompare(signature, expectedSignature)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  // Record nonce only after authentication succeeds.
  // Anchor retention to the later of currentTime and requestTime so that
  // a valid request near the replay-window limit isn't evicted prematurely.
  nonceStore.record(nonce, Math.max(currentTime, requestTime));

  return { ok: true, connectionId };
}

// ---------------------------------------------------------------------------
// Stateless verification (no DB lookup)
// ---------------------------------------------------------------------------

/**
 * Verify a request signature without looking up the connection in the DB.
 * Useful when the caller has already resolved the connection and credential.
 *
 * Performs: timestamp check, nonce check, HMAC verification.
 */
export function verifySignature(params: {
  signature: string;
  timestamp: string;
  nonce: string;
  body: string;
  credential: string;
  nonceStore?: NonceStore;
  replayWindowMs?: number;
  now?: number;
}): { ok: true } | { ok: false; reason: 'timestamp_expired' | 'nonce_replayed' | 'invalid_signature' } {
  const {
    signature,
    timestamp,
    nonce,
    body,
    credential,
  } = params;
  const nonceStore = params.nonceStore ?? defaultNonceStore;
  const replayWindowMs = params.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const currentTime = params.now ?? Date.now();

  // Timestamp check
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime) || Math.abs(currentTime - requestTime) > replayWindowMs) {
    return { ok: false, reason: 'timestamp_expired' };
  }

  // Nonce check (read-only before HMAC)
  if (nonceStore.isKnown(nonce, currentTime)) {
    return { ok: false, reason: 'nonce_replayed' };
  }

  // HMAC check
  const payload = buildSigningPayload(timestamp, nonce, body);
  const expectedSignature = computeHmac(credential, payload);

  if (!timingSafeCompare(signature, expectedSignature)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  // Record nonce only after authentication succeeds.
  // Anchor retention to the later of currentTime and requestTime so that
  // a valid request near the replay-window limit isn't evicted prematurely.
  nonceStore.record(nonce, Math.max(currentTime, requestTime));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Credential rotation
// ---------------------------------------------------------------------------

/**
 * Rotate credentials for an active connection. Generates a new credential
 * pair, updates the connection store, and returns both the new credentials
 * (for exchange with the peer) and the updated connection.
 *
 * The old credentials are invalidated immediately -- any subsequent request
 * using the old credentials will fail verification because the stored hashes
 * no longer match.
 */
export function rotateCredentials(connectionId: string): RotateResult {
  const connection = getConnection(connectionId);
  if (!connection) {
    return { ok: false, reason: 'connection_not_found' };
  }

  if (connection.status !== 'active') {
    return { ok: false, reason: 'connection_not_active' };
  }

  const newCredentials = generateCredentialPair();

  const updated = updateConnectionCredentials(connectionId, {
    outboundCredentialHash: newCredentials.outboundCredentialHash,
    inboundCredentialHash: newCredentials.inboundCredentialHash,
    inboundCredential: newCredentials.inboundCredential,
  });

  if (!updated) {
    return { ok: false, reason: 'connection_not_found' };
  }

  return {
    ok: true,
    newCredentials,
    connection: updated,
  };
}

// ---------------------------------------------------------------------------
// Credential revocation
// ---------------------------------------------------------------------------

/**
 * Revoke credentials for a connection. Transitions the connection to
 * 'revoked' status and tombstones the credential hashes.
 *
 * After revocation, any request using the old credentials will be rejected
 * because `verifyRequest` checks connection status before signature
 * verification.
 */
export function revokeCredentials(connectionId: string): RevokeResult {
  const connection = getConnection(connectionId);
  if (!connection) {
    return { ok: false, reason: 'connection_not_found' };
  }

  if (connection.status === 'revoked' || connection.status === 'revoked_by_peer') {
    return { ok: false, reason: 'already_revoked' };
  }

  // Tombstone the credentials by nullifying them
  updateConnectionCredentials(connectionId, {
    outboundCredentialHash: '',
    inboundCredentialHash: '',
    inboundCredential: '',
  });

  // Transition to revoked status
  const updated = updateConnectionStatus(connectionId, 'revoked');
  if (!updated) {
    return { ok: false, reason: 'connection_not_found' };
  }

  return { ok: true, connection: updated };
}
