/**
 * A2A handshake primitives.
 *
 * Provides the cryptographic building blocks and state machine for establishing
 * secure peer-to-peer connections between Vellum assistants. Intentionally
 * isolated from the device pairing code paths (QR/iOS) — the two systems share
 * similar crypto patterns but have different lifecycles and trust anchors.
 *
 * The handshake state machine follows the flow described in the A2A architecture
 * doc: awaiting_request -> awaiting_approval -> awaiting_verification -> verified -> active.
 */

import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants — TTL defaults
// ---------------------------------------------------------------------------

/** Invite token TTL: 24 hours. */
export const INVITE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Verification code TTL: 5 minutes. */
export const VERIFICATION_CODE_TTL_MS = 5 * 60 * 1000;

/** Handshake session TTL: 15 minutes. */
export const HANDSHAKE_SESSION_TTL_MS = 15 * 60 * 1000;

/** Maximum verification code attempts before session invalidation. */
export const MAX_VERIFICATION_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Handshake state machine types
// ---------------------------------------------------------------------------

/**
 * Handshake states track the connection establishment lifecycle.
 * Each state has defined valid transitions and timeout behavior.
 */
export type HandshakeState =
  | 'awaiting_request'
  | 'awaiting_approval'
  | 'awaiting_verification'
  | 'verified'
  | 'active';

export interface HandshakeSession {
  id: string;
  state: HandshakeState;
  /** Identity of the peer that initiated the connection request. */
  peerIdentity: string | null;
  /** Invite token hash associated with this handshake. */
  inviteTokenHash: string | null;
  /** Hash of the verification code (set when entering awaiting_verification). */
  verificationCodeHash: string | null;
  /** Number of verification code attempts made. */
  verificationAttempts: number;
  createdAt: number;
  updatedAt: number;
  /** Absolute timestamp when this session expires. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Secret hashing
// ---------------------------------------------------------------------------

/**
 * Hash a handshake secret (invite token, verification code) using SHA-256.
 * Consistent with the hashing approach used throughout the codebase
 * (channel-guardian-service, ingress-invite-store, voice-code).
 */
export function hashHandshakeSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// ---------------------------------------------------------------------------
// Timing-safe compare
// ---------------------------------------------------------------------------

/**
 * Compare two hex-encoded hashes in constant time. Prevents timing attacks
 * on code/token verification by ensuring the comparison takes the same
 * amount of time regardless of where the mismatch occurs.
 *
 * Returns false (rather than throwing) when the inputs have different lengths,
 * which can happen if a caller passes an unhashed value by mistake.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Verification code generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 6-digit numeric verification code.
 * Uses `randomInt` for uniform distribution across the range [100000, 999999].
 * Mirrors the pattern in `util/voice-code.ts`.
 */
export function generateVerificationCode(digits: number = 6): string {
  if (digits < 4 || digits > 10) {
    throw new Error(`Verification code digit count must be between 4 and 10, got ${digits}`);
  }
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits);
  return String(randomInt(min, max));
}

// ---------------------------------------------------------------------------
// TTL management
// ---------------------------------------------------------------------------

/**
 * Check whether a handshake session has expired based on its `expiresAt`
 * timestamp. Pure function — no side effects.
 */
export function isSessionExpired(session: Pick<HandshakeSession, 'expiresAt'>, now?: number): boolean {
  return (now ?? Date.now()) >= session.expiresAt;
}

/**
 * Compute an absolute expiration timestamp from a creation time and TTL.
 */
export function computeExpiresAt(createdAt: number, ttlMs: number): number {
  return createdAt + ttlMs;
}

// ---------------------------------------------------------------------------
// Handshake session factory
// ---------------------------------------------------------------------------

/**
 * Create a new handshake session in the `awaiting_request` state.
 * The session is initialized with the handshake session TTL by default.
 */
export function createHandshakeSession(params?: {
  ttlMs?: number;
  inviteTokenHash?: string;
}): HandshakeSession {
  const now = Date.now();
  return {
    id: randomUUID(),
    state: 'awaiting_request',
    peerIdentity: null,
    inviteTokenHash: params?.inviteTokenHash ?? null,
    verificationCodeHash: null,
    verificationAttempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: computeExpiresAt(now, params?.ttlMs ?? HANDSHAKE_SESSION_TTL_MS),
  };
}

// ---------------------------------------------------------------------------
// Anti-hijack binding
// ---------------------------------------------------------------------------

/**
 * Bind a peer identity to a handshake session. Once bound, all subsequent
 * steps (code submission, verification) must come from the same peer.
 * Prevents session hijacking where an attacker intercepts a handshake
 * mid-flow and tries to complete it with their own identity.
 *
 * Returns a new session object (immutable update pattern).
 */
export function bindPeerIdentity(
  session: HandshakeSession,
  peerIdentity: string,
): HandshakeSession {
  return {
    ...session,
    peerIdentity,
    updatedAt: Date.now(),
  };
}

/**
 * Verify that a peer identity matches the one bound to the session.
 * Returns false if no identity is bound (session has not been claimed yet)
 * or if the identity does not match.
 */
export function verifyPeerIdentity(session: HandshakeSession, peerIdentity: string): boolean {
  if (session.peerIdentity === null) return false;
  return session.peerIdentity === peerIdentity;
}

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { ok: true; session: HandshakeSession }
  | { ok: false; reason: 'invalid_transition' | 'expired' | 'identity_mismatch' | 'max_attempts' }
  | { ok: false; reason: 'invalid_code'; session: HandshakeSession };

/**
 * Transition a handshake session from `awaiting_request` to `awaiting_approval`.
 *
 * Binds the requesting peer's identity to the session (anti-hijack).
 * This is the entry point for a connection request from a peer.
 */
export function transitionToAwaitingApproval(
  session: HandshakeSession,
  peerIdentity: string,
  now?: number,
): TransitionResult {
  const currentTime = now ?? Date.now();

  if (isSessionExpired(session, currentTime)) {
    return { ok: false, reason: 'expired' };
  }

  if (session.state !== 'awaiting_request') {
    return { ok: false, reason: 'invalid_transition' };
  }

  return {
    ok: true,
    session: {
      ...session,
      state: 'awaiting_approval',
      peerIdentity,
      updatedAt: currentTime,
    },
  };
}

/**
 * Transition from `awaiting_approval` to `awaiting_verification`.
 *
 * Called when the guardian approves the connection request. Generates and
 * stores the verification code hash, and resets the TTL to the verification
 * code TTL (shorter window for code exchange).
 */
export function transitionToAwaitingVerification(
  session: HandshakeSession,
  verificationCodeHash: string,
  now?: number,
): TransitionResult {
  const currentTime = now ?? Date.now();

  if (isSessionExpired(session, currentTime)) {
    return { ok: false, reason: 'expired' };
  }

  if (session.state !== 'awaiting_approval') {
    return { ok: false, reason: 'invalid_transition' };
  }

  return {
    ok: true,
    session: {
      ...session,
      state: 'awaiting_verification',
      verificationCodeHash,
      verificationAttempts: 0,
      updatedAt: currentTime,
      // Tighten the expiry window for the verification code exchange
      expiresAt: computeExpiresAt(currentTime, VERIFICATION_CODE_TTL_MS),
    },
  };
}

/**
 * Transition from `awaiting_verification` to `verified`.
 *
 * Validates the submitted verification code against the stored hash using
 * timing-safe comparison. Enforces anti-hijack identity binding and
 * attempt limits.
 */
export function transitionToVerified(
  session: HandshakeSession,
  submittedCodeHash: string,
  peerIdentity: string,
  now?: number,
): TransitionResult {
  const currentTime = now ?? Date.now();

  if (isSessionExpired(session, currentTime)) {
    return { ok: false, reason: 'expired' };
  }

  if (session.state !== 'awaiting_verification') {
    return { ok: false, reason: 'invalid_transition' };
  }

  // Anti-hijack: verify the submitter matches the bound peer
  // Treat null peerIdentity as an invariant violation — normal flow always sets it in transitionToAwaitingApproval
  if (session.peerIdentity === null || session.peerIdentity !== peerIdentity) {
    return { ok: false, reason: 'identity_mismatch' };
  }

  // Check attempt limit before comparing codes
  if (session.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
    return { ok: false, reason: 'max_attempts' };
  }

  // Timing-safe comparison of hashed codes
  if (!session.verificationCodeHash || !timingSafeCompare(session.verificationCodeHash, submittedCodeHash)) {
    const updatedSession: HandshakeSession = {
      ...session,
      verificationAttempts: session.verificationAttempts + 1,
      updatedAt: currentTime,
    };
    return {
      ok: false,
      reason: 'invalid_code',
      session: updatedSession,
    };
  }

  return {
    ok: true,
    session: {
      ...session,
      state: 'verified',
      updatedAt: currentTime,
    },
  };
}

/**
 * Transition from `verified` to `active`.
 *
 * Called after credential exchange is complete. The connection is now live.
 */
export function transitionToActive(
  session: HandshakeSession,
  now?: number,
): TransitionResult {
  const currentTime = now ?? Date.now();

  if (isSessionExpired(session, currentTime)) {
    return { ok: false, reason: 'expired' };
  }

  if (session.state !== 'verified') {
    return { ok: false, reason: 'invalid_transition' };
  }

  return {
    ok: true,
    session: {
      ...session,
      state: 'active',
      updatedAt: currentTime,
      // Active connections have no session-level timeout
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  };
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

export interface HandshakeStatus {
  sessionId: string;
  state: HandshakeState;
  expired: boolean;
  peerBound: boolean;
  verificationAttemptsRemaining: number;
  expiresAt: number;
}

/**
 * Return the current status of a handshake session for polling.
 * The initiating side uses this to check progress while waiting
 * for approval or verification.
 */
export function getHandshakeStatus(session: HandshakeSession, now?: number): HandshakeStatus {
  const currentTime = now ?? Date.now();
  const expired = isSessionExpired(session, currentTime);

  // Remaining attempts only meaningful during the verification phase
  const attemptsRemaining =
    session.state === 'awaiting_verification'
      ? Math.max(0, MAX_VERIFICATION_ATTEMPTS - session.verificationAttempts)
      : MAX_VERIFICATION_ATTEMPTS;

  return {
    sessionId: session.id,
    state: session.state,
    expired,
    peerBound: session.peerIdentity !== null,
    verificationAttemptsRemaining: attemptsRemaining,
    expiresAt: session.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// TTL sweep helper
// ---------------------------------------------------------------------------

/**
 * Filter a list of handshake sessions to remove expired ones.
 * Intended for periodic sweep operations.
 */
export function sweepExpiredSessions(
  sessions: HandshakeSession[],
  now?: number,
): { active: HandshakeSession[]; expired: HandshakeSession[] } {
  const currentTime = now ?? Date.now();
  const active: HandshakeSession[] = [];
  const expired: HandshakeSession[] = [];

  for (const session of sessions) {
    if (isSessionExpired(session, currentTime)) {
      expired.push(session);
    } else {
      active.push(session);
    }
  }

  return { active, expired };
}
