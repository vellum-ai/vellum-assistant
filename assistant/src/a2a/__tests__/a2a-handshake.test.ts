import { describe, expect, test } from 'bun:test';

import {
  HANDSHAKE_SESSION_TTL_MS,
  INVITE_TOKEN_TTL_MS,
  MAX_VERIFICATION_ATTEMPTS,
  VERIFICATION_CODE_TTL_MS,
  bindPeerIdentity,
  computeExpiresAt,
  createHandshakeSession,
  generateVerificationCode,
  getHandshakeStatus,
  hashHandshakeSecret,
  isSessionExpired,
  sweepExpiredSessions,
  timingSafeCompare,
  transitionToActive,
  transitionToAwaitingApproval,
  transitionToAwaitingVerification,
  transitionToVerified,
  verifyPeerIdentity,
} from '../a2a-handshake.js';

// ---------------------------------------------------------------------------
// Secret hashing
// ---------------------------------------------------------------------------

describe('hashHandshakeSecret', () => {
  test('produces a hex-encoded SHA-256 hash', () => {
    const hash = hashHandshakeSecret('test-secret');
    // SHA-256 produces a 64-character hex string
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same input produces same hash (deterministic)', () => {
    const a = hashHandshakeSecret('hello');
    const b = hashHandshakeSecret('hello');
    expect(a).toBe(b);
  });

  test('different inputs produce different hashes', () => {
    const a = hashHandshakeSecret('secret-1');
    const b = hashHandshakeSecret('secret-2');
    expect(a).not.toBe(b);
  });

  test('empty string produces a valid hash', () => {
    const hash = hashHandshakeSecret('');
    expect(hash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Timing-safe compare
// ---------------------------------------------------------------------------

describe('timingSafeCompare', () => {
  test('returns true for identical strings', () => {
    const hash = hashHandshakeSecret('test');
    expect(timingSafeCompare(hash, hash)).toBe(true);
  });

  test('returns true for equal but distinct string instances', () => {
    const a = hashHandshakeSecret('same-input');
    const b = hashHandshakeSecret('same-input');
    expect(timingSafeCompare(a, b)).toBe(true);
  });

  test('returns false for different strings of equal length', () => {
    const a = hashHandshakeSecret('input-a');
    const b = hashHandshakeSecret('input-b');
    expect(timingSafeCompare(a, b)).toBe(false);
  });

  test('returns false for strings of different lengths', () => {
    expect(timingSafeCompare('short', 'much-longer-string')).toBe(false);
  });

  test('returns false for empty vs non-empty', () => {
    expect(timingSafeCompare('', 'abc')).toBe(false);
  });

  test('returns true for two empty strings', () => {
    expect(timingSafeCompare('', '')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verification code generation
// ---------------------------------------------------------------------------

describe('generateVerificationCode', () => {
  test('generates a 6-digit numeric code by default', () => {
    const code = generateVerificationCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^\d{6}$/);
  });

  test('generates codes of the specified digit count', () => {
    const code4 = generateVerificationCode(4);
    expect(code4).toHaveLength(4);
    expect(code4).toMatch(/^\d{4}$/);

    const code8 = generateVerificationCode(8);
    expect(code8).toHaveLength(8);
    expect(code8).toMatch(/^\d{8}$/);
  });

  test('codes never start with zero (always have full digit count)', () => {
    // Run multiple times to catch statistical edge cases
    for (let i = 0; i < 100; i++) {
      const code = generateVerificationCode(6);
      expect(code).toHaveLength(6);
      const num = parseInt(code, 10);
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThan(1000000);
    }
  });

  test('generates different codes on successive calls', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      codes.add(generateVerificationCode());
    }
    // With 50 random 6-digit codes, collisions are extremely unlikely
    expect(codes.size).toBeGreaterThan(45);
  });

  test('throws for digit count below 4', () => {
    expect(() => generateVerificationCode(3)).toThrow();
  });

  test('throws for digit count above 10', () => {
    expect(() => generateVerificationCode(11)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TTL management
// ---------------------------------------------------------------------------

describe('TTL constants', () => {
  test('invite token TTL is 24 hours', () => {
    expect(INVITE_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  test('verification code TTL is 5 minutes', () => {
    expect(VERIFICATION_CODE_TTL_MS).toBe(5 * 60 * 1000);
  });

  test('handshake session TTL is 15 minutes', () => {
    expect(HANDSHAKE_SESSION_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe('isSessionExpired', () => {
  test('returns false when session has not expired', () => {
    const session = createHandshakeSession();
    expect(isSessionExpired(session)).toBe(false);
  });

  test('returns true when current time is past expiresAt', () => {
    const session = createHandshakeSession();
    const future = session.expiresAt + 1;
    expect(isSessionExpired(session, future)).toBe(true);
  });

  test('returns true when current time equals expiresAt (boundary)', () => {
    const session = createHandshakeSession();
    expect(isSessionExpired(session, session.expiresAt)).toBe(true);
  });

  test('returns false one millisecond before expiry', () => {
    const session = createHandshakeSession();
    expect(isSessionExpired(session, session.expiresAt - 1)).toBe(false);
  });
});

describe('computeExpiresAt', () => {
  test('adds TTL to creation time', () => {
    const created = 1000000;
    const ttl = 300000; // 5 minutes
    expect(computeExpiresAt(created, ttl)).toBe(1300000);
  });
});

// ---------------------------------------------------------------------------
// Handshake session creation
// ---------------------------------------------------------------------------

describe('createHandshakeSession', () => {
  test('creates a session in awaiting_request state', () => {
    const session = createHandshakeSession();
    expect(session.state).toBe('awaiting_request');
  });

  test('generates a unique UUID id', () => {
    const a = createHandshakeSession();
    const b = createHandshakeSession();
    expect(a.id).not.toBe(b.id);
    // UUID v4 format
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('initializes with null peer identity and verification fields', () => {
    const session = createHandshakeSession();
    expect(session.peerIdentity).toBeNull();
    expect(session.verificationCodeHash).toBeNull();
    expect(session.verificationAttempts).toBe(0);
  });

  test('uses default handshake session TTL', () => {
    const before = Date.now();
    const session = createHandshakeSession();
    const after = Date.now();

    expect(session.expiresAt).toBeGreaterThanOrEqual(before + HANDSHAKE_SESSION_TTL_MS);
    expect(session.expiresAt).toBeLessThanOrEqual(after + HANDSHAKE_SESSION_TTL_MS);
  });

  test('accepts custom TTL', () => {
    const customTtl = 60 * 1000; // 1 minute
    const before = Date.now();
    const session = createHandshakeSession({ ttlMs: customTtl });
    const after = Date.now();

    expect(session.expiresAt).toBeGreaterThanOrEqual(before + customTtl);
    expect(session.expiresAt).toBeLessThanOrEqual(after + customTtl);
  });

  test('stores invite token hash when provided', () => {
    const session = createHandshakeSession({ inviteTokenHash: 'hash-abc' });
    expect(session.inviteTokenHash).toBe('hash-abc');
  });
});

// ---------------------------------------------------------------------------
// Anti-hijack binding
// ---------------------------------------------------------------------------

describe('bindPeerIdentity', () => {
  test('binds a peer identity to a session', () => {
    const session = createHandshakeSession();
    const bound = bindPeerIdentity(session, 'peer-gateway-123');

    expect(bound.peerIdentity).toBe('peer-gateway-123');
  });

  test('does not mutate the original session', () => {
    const session = createHandshakeSession();
    const bound = bindPeerIdentity(session, 'peer-gateway-123');

    expect(session.peerIdentity).toBeNull();
    expect(bound.peerIdentity).toBe('peer-gateway-123');
  });

  test('updates the updatedAt timestamp', () => {
    const session = createHandshakeSession();
    const bound = bindPeerIdentity(session, 'peer');

    expect(bound.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
  });
});

describe('verifyPeerIdentity', () => {
  test('returns true when identity matches', () => {
    const session = bindPeerIdentity(createHandshakeSession(), 'peer-123');
    expect(verifyPeerIdentity(session, 'peer-123')).toBe(true);
  });

  test('returns false when identity does not match', () => {
    const session = bindPeerIdentity(createHandshakeSession(), 'peer-123');
    expect(verifyPeerIdentity(session, 'attacker-456')).toBe(false);
  });

  test('returns false when no identity is bound', () => {
    const session = createHandshakeSession();
    expect(verifyPeerIdentity(session, 'any-peer')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State machine transitions — valid paths
// ---------------------------------------------------------------------------

describe('state machine — happy path', () => {
  test('full lifecycle: awaiting_request -> awaiting_approval -> awaiting_verification -> verified -> active', () => {
    const code = generateVerificationCode();
    const codeHash = hashHandshakeSecret(code);
    const now = Date.now();

    // Step 1: awaiting_request -> awaiting_approval
    let session = createHandshakeSession();
    const step1 = transitionToAwaitingApproval(session, 'peer-123', now);
    expect(step1.ok).toBe(true);
    if (!step1.ok) throw new Error('unreachable');
    session = step1.session;
    expect(session.state).toBe('awaiting_approval');
    expect(session.peerIdentity).toBe('peer-123');

    // Step 2: awaiting_approval -> awaiting_verification
    const step2 = transitionToAwaitingVerification(session, codeHash, now);
    expect(step2.ok).toBe(true);
    if (!step2.ok) throw new Error('unreachable');
    session = step2.session;
    expect(session.state).toBe('awaiting_verification');
    expect(session.verificationCodeHash).toBe(codeHash);

    // Step 3: awaiting_verification -> verified
    const submittedHash = hashHandshakeSecret(code);
    const step3 = transitionToVerified(session, submittedHash, 'peer-123', now);
    expect(step3.ok).toBe(true);
    if (!step3.ok) throw new Error('unreachable');
    session = step3.session;
    expect(session.state).toBe('verified');

    // Step 4: verified -> active
    const step4 = transitionToActive(session, now);
    expect(step4.ok).toBe(true);
    if (!step4.ok) throw new Error('unreachable');
    session = step4.session;
    expect(session.state).toBe('active');
    // Active sessions have no meaningful timeout
    expect(session.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ---------------------------------------------------------------------------
// State machine transitions — invalid paths
// ---------------------------------------------------------------------------

describe('state machine — invalid transitions', () => {
  test('cannot skip from awaiting_request to awaiting_verification', () => {
    const session = createHandshakeSession();
    const result = transitionToAwaitingVerification(session, 'hash');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_transition');
  });

  test('cannot skip from awaiting_request to verified', () => {
    const session = createHandshakeSession();
    const result = transitionToVerified(session, 'hash', 'peer');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_transition');
  });

  test('cannot skip from awaiting_request to active', () => {
    const session = createHandshakeSession();
    const result = transitionToActive(session);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_transition');
  });

  test('cannot go from awaiting_approval to active directly', () => {
    const session = createHandshakeSession();
    const step1 = transitionToAwaitingApproval(session, 'peer');
    if (!step1.ok) throw new Error('unreachable');
    const result = transitionToActive(step1.session);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_transition');
  });

  test('cannot transition from active state', () => {
    // Build up to active state
    const code = generateVerificationCode();
    const codeHash = hashHandshakeSecret(code);
    const now = Date.now();

    let session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');
    const s3 = transitionToVerified(s2.session, hashHandshakeSecret(code), 'peer', now);
    if (!s3.ok) throw new Error('unreachable');
    const s4 = transitionToActive(s3.session, now);
    if (!s4.ok) throw new Error('unreachable');
    session = s4.session;

    // Try to transition again — no valid next state from active
    const result = transitionToAwaitingApproval(session, 'peer', now);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_transition');
  });
});

// ---------------------------------------------------------------------------
// State machine — expiry
// ---------------------------------------------------------------------------

describe('state machine — expired sessions', () => {
  test('rejects transition when session is expired (awaiting_request)', () => {
    const session = createHandshakeSession({ ttlMs: 1 });
    const futureTime = session.expiresAt + 1000;

    const result = transitionToAwaitingApproval(session, 'peer', futureTime);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('expired');
  });

  test('rejects transition when session is expired (awaiting_approval)', () => {
    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer');
    if (!s1.ok) throw new Error('unreachable');

    const futureTime = s1.session.expiresAt + 1000;
    const result = transitionToAwaitingVerification(s1.session, 'hash', futureTime);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('expired');
  });

  test('rejects transition when verification code TTL has elapsed', () => {
    const now = Date.now();
    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');

    const code = generateVerificationCode();
    const codeHash = hashHandshakeSecret(code);
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    // The verification phase has its own shorter TTL (5 minutes)
    const afterCodeExpiry = s2.session.expiresAt + 1;
    const result = transitionToVerified(s2.session, hashHandshakeSecret(code), 'peer', afterCodeExpiry);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// State machine — anti-hijack binding
// ---------------------------------------------------------------------------

describe('state machine — anti-hijack binding', () => {
  test('rejects verification from a different peer identity', () => {
    const now = Date.now();
    const code = generateVerificationCode();
    const codeHash = hashHandshakeSecret(code);

    let session = createHandshakeSession();
    // Peer A initiates and gets bound
    const s1 = transitionToAwaitingApproval(session, 'peer-A', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    // Attacker (peer B) tries to submit the code
    const result = transitionToVerified(s2.session, hashHandshakeSecret(code), 'peer-B', now);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('identity_mismatch');
  });

  test('allows verification from the same peer identity', () => {
    const now = Date.now();
    const code = generateVerificationCode();
    const codeHash = hashHandshakeSecret(code);

    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer-A', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    const result = transitionToVerified(s2.session, hashHandshakeSecret(code), 'peer-A', now);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.state).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// State machine — verification code attempts
// ---------------------------------------------------------------------------

describe('state machine — verification code attempts', () => {
  test('wrong code returns invalid_code with incremented attempt count', () => {
    const now = Date.now();
    const correctCode = generateVerificationCode();
    const codeHash = hashHandshakeSecret(correctCode);

    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    const wrongCodeHash = hashHandshakeSecret('000000');
    const result = transitionToVerified(s2.session, wrongCodeHash, 'peer', now);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid_code');
    expect('session' in result).toBe(true);
    if (!('session' in result)) throw new Error('unreachable');
    expect((result as { session: { verificationAttempts: number } }).session.verificationAttempts).toBe(1);
  });

  test('rejects after max verification attempts', () => {
    const now = Date.now();
    const correctCode = generateVerificationCode();
    const codeHash = hashHandshakeSecret(correctCode);

    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    // Exhaust all attempts with wrong codes
    let current = s2.session;
    const wrongHash = hashHandshakeSecret('000000');
    for (let i = 0; i < MAX_VERIFICATION_ATTEMPTS; i++) {
      const result = transitionToVerified(current, wrongHash, 'peer', now);
      expect(result.ok).toBe(false);
      if ('session' in result) {
        current = result.session;
      }
    }

    // Now even the correct code should fail with max_attempts
    const finalResult = transitionToVerified(current, hashHandshakeSecret(correctCode), 'peer', now);
    expect(finalResult.ok).toBe(false);
    if (finalResult.ok) throw new Error('unreachable');
    expect(finalResult.reason).toBe('max_attempts');
  });

  test('correct code succeeds even after prior wrong attempts (within limit)', () => {
    const now = Date.now();
    const correctCode = generateVerificationCode();
    const codeHash = hashHandshakeSecret(correctCode);

    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    // Two wrong attempts
    const wrongHash = hashHandshakeSecret('000000');
    let current = s2.session;
    for (let i = 0; i < 2; i++) {
      const result = transitionToVerified(current, wrongHash, 'peer', now);
      if ('session' in result) {
        current = result.session;
      }
    }
    expect(current.verificationAttempts).toBe(2);

    // Correct code on 3rd attempt (still within limit)
    const result = transitionToVerified(current, hashHandshakeSecret(correctCode), 'peer', now);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.session.state).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

describe('getHandshakeStatus', () => {
  test('returns correct status for a new session', () => {
    const session = createHandshakeSession();
    const status = getHandshakeStatus(session);

    expect(status.sessionId).toBe(session.id);
    expect(status.state).toBe('awaiting_request');
    expect(status.expired).toBe(false);
    expect(status.peerBound).toBe(false);
    expect(status.verificationAttemptsRemaining).toBe(MAX_VERIFICATION_ATTEMPTS);
  });

  test('reports expired status when session has timed out', () => {
    const session = createHandshakeSession({ ttlMs: 1 });
    const status = getHandshakeStatus(session, session.expiresAt + 1);

    expect(status.expired).toBe(true);
  });

  test('reports peer bound after identity binding', () => {
    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer-123');
    if (!s1.ok) throw new Error('unreachable');

    const status = getHandshakeStatus(s1.session);
    expect(status.peerBound).toBe(true);
    expect(status.state).toBe('awaiting_approval');
  });

  test('reports correct remaining attempts during verification', () => {
    const now = Date.now();
    const code = generateVerificationCode();
    const codeHash = hashHandshakeSecret(code);

    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    // Before any attempts
    let status = getHandshakeStatus(s2.session, now);
    expect(status.verificationAttemptsRemaining).toBe(MAX_VERIFICATION_ATTEMPTS);

    // After one wrong attempt
    const wrongHash = hashHandshakeSecret('000000');
    const wrongResult = transitionToVerified(s2.session, wrongHash, 'peer', now);
    if (!('session' in wrongResult)) throw new Error('unreachable');
    status = getHandshakeStatus(wrongResult.session, now);
    expect(status.verificationAttemptsRemaining).toBe(MAX_VERIFICATION_ATTEMPTS - 1);
  });

  test('reports active state with no expiration concern', () => {
    const now = Date.now();
    const code = generateVerificationCode();
    const codeHash = hashHandshakeSecret(code);

    let session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');
    const s3 = transitionToVerified(s2.session, hashHandshakeSecret(code), 'peer', now);
    if (!s3.ok) throw new Error('unreachable');
    const s4 = transitionToActive(s3.session, now);
    if (!s4.ok) throw new Error('unreachable');
    session = s4.session;

    const status = getHandshakeStatus(session, now);
    expect(status.state).toBe('active');
    expect(status.expired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TTL sweep
// ---------------------------------------------------------------------------

describe('sweepExpiredSessions', () => {
  test('separates active and expired sessions', () => {
    const now = Date.now();
    const active1 = { ...createHandshakeSession(), expiresAt: now + 10000 };
    const active2 = { ...createHandshakeSession(), expiresAt: now + 20000 };
    const expired1 = { ...createHandshakeSession(), expiresAt: now - 1000 };
    const expired2 = { ...createHandshakeSession(), expiresAt: now - 5000 };

    const result = sweepExpiredSessions([active1, active2, expired1, expired2], now);

    expect(result.active).toHaveLength(2);
    expect(result.expired).toHaveLength(2);
    expect(result.active.map((s) => s.id)).toContain(active1.id);
    expect(result.active.map((s) => s.id)).toContain(active2.id);
    expect(result.expired.map((s) => s.id)).toContain(expired1.id);
    expect(result.expired.map((s) => s.id)).toContain(expired2.id);
  });

  test('returns empty arrays for empty input', () => {
    const result = sweepExpiredSessions([]);
    expect(result.active).toHaveLength(0);
    expect(result.expired).toHaveLength(0);
  });

  test('all active when none expired', () => {
    const sessions = [createHandshakeSession(), createHandshakeSession()];
    const result = sweepExpiredSessions(sessions);
    expect(result.active).toHaveLength(2);
    expect(result.expired).toHaveLength(0);
  });

  test('boundary: expiresAt exactly at now is expired', () => {
    const now = Date.now();
    const session = { ...createHandshakeSession(), expiresAt: now };
    const result = sweepExpiredSessions([session], now);
    expect(result.expired).toHaveLength(1);
    expect(result.active).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Transition tightens TTL for verification phase
// ---------------------------------------------------------------------------

describe('verification phase TTL tightening', () => {
  test('transitionToAwaitingVerification sets expiresAt to verification code TTL', () => {
    const now = Date.now();
    const session = createHandshakeSession();
    const s1 = transitionToAwaitingApproval(session, 'peer', now);
    if (!s1.ok) throw new Error('unreachable');

    const codeHash = hashHandshakeSecret('123456');
    const s2 = transitionToAwaitingVerification(s1.session, codeHash, now);
    if (!s2.ok) throw new Error('unreachable');

    // The verification phase should have a tighter TTL than the session TTL
    expect(s2.session.expiresAt).toBe(now + VERIFICATION_CODE_TTL_MS);
    expect(VERIFICATION_CODE_TTL_MS).toBeLessThan(HANDSHAKE_SESSION_TTL_MS);
  });
});
