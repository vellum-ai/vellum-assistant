# A2A / Device Pairing Convergence Analysis

Evaluates whether the handshake and authentication internals of the A2A peer
communication system and the iOS device pairing system should be converged
into shared primitives. This is a refactor-only evaluation -- no product-facing
behavior changes are proposed.

Related docs:
- [A2A Architecture](a2a-architecture.md)
- [A2A Communications Design](a2a-communications.md)
- [Security](security.md)

---

## 1. Catalog of Shared Patterns

The A2A and pairing systems independently implement several cryptographic and
lifecycle primitives. The table below maps each pattern to its concrete
implementations.

### 1.1 SHA-256 Secret Hashing

Both systems hash secrets with SHA-256 before storage and compare only hashes
at verification time.

| System | Function | File |
|--------|----------|------|
| A2A handshake | `hashHandshakeSecret(secret)` | `a2a/a2a-handshake.ts` |
| A2A peer auth | `hashHandshakeSecret()` (reused) | `a2a/a2a-peer-auth.ts` |
| Device pairing | `hashValue(value)` | `daemon/pairing-store.ts` |
| Approved devices | `hashDeviceId(deviceId)` | `daemon/approved-devices-store.ts` |
| Guardian service | `hashSecret(secret)` | `runtime/channel-guardian-service.ts` |
| Ingress invites | `hashToken(rawToken)` | `memory/ingress-invite-store.ts` |
| Voice codes | `hashVoiceCode(code)` | `util/voice-code.ts` |

All seven implementations are identical: `createHash('sha256').update(input).digest('hex')`.

### 1.2 Timing-Safe Comparison

Constant-time comparison of hashed values to prevent timing side-channel
attacks on secret verification.

| System | Function | File |
|--------|----------|------|
| A2A handshake | `timingSafeCompare(a, b)` | `a2a/a2a-handshake.ts` |
| Device pairing | `timingSafeCompare(a, b)` | `daemon/pairing-store.ts` |

Both convert to Buffers, check length equality, then delegate to
`crypto.timingSafeEqual`. The A2A version uses `'utf-8'` encoding explicitly;
the pairing version uses Node's default (also UTF-8). Functionally identical.

### 1.3 Numeric Code Generation

Cryptographically random N-digit numeric codes for out-of-band verification.

| System | Function | File |
|--------|----------|------|
| A2A handshake | `generateVerificationCode(digits)` | `a2a/a2a-handshake.ts` |
| Guardian service | `generateNumericSecret(digits)` | `runtime/channel-guardian-service.ts` |
| Voice codes | `generateVoiceCode(digits)` | `util/voice-code.ts` |

All three use `randomInt(10^(d-1), 10^d)` with a 4-10 digit range guard. The
A2A and voice code versions are nearly character-for-character identical. The
guardian service version differs only in using `randomBytes(4).readUInt32BE(0) % max`
with zero-padding, which introduces slight distribution bias for large digit
counts (negligible for 6 digits).

### 1.4 TTL / Expiry Management

Absolute-timestamp-based expiry with periodic sweep to clean up stale entries.

| System | Mechanism | Sweep Strategy |
|--------|-----------|----------------|
| A2A handshake | `expiresAt` field, `isSessionExpired()`, `sweepExpiredSessions()` | Caller-driven (filter on read) |
| A2A peer auth | `NonceStore` with `replayWindowMs` cutoff | Opportunistic on `isKnown()`/`record()` |
| A2A message dedup | `MessageDedupStore` with TTL + hard cap | Opportunistic on `isDuplicate()`/`isKnown()` |
| A2A revocation sweep | `setInterval` timer, in-memory attempt counter | Timer-driven (5-minute interval) |
| Device pairing | `TTL_MS` with `setInterval` sweep | Timer-driven (30-second interval) |
| Guardian service | `CHALLENGE_TTL_MS`, expires checked on validate | DB query-time filter |

The patterns share the same core concept (timestamp comparison against
`now`) but use different sweep strategies suited to their data volumes and
access patterns.

### 1.5 Rate Limiting

Protection against brute-force attempts on verification endpoints.

| System | Mechanism | File |
|--------|-----------|------|
| A2A | `A2ARateLimiter` class (sliding window, per-key) | `a2a/a2a-rate-limiter.ts` |
| Guardian service | `getRateLimit()` / `recordInvalidAttempt()` (DB-backed, lockout model) | `runtime/channel-guardian-service.ts` + `memory/channel-guardian-store.ts` |

These use fundamentally different approaches: A2A uses in-memory sliding
windows; guardian verification uses persistent DB records with lockout
durations. The difference is intentional -- A2A connections are ephemeral and
daemon-scoped, while guardian verification state must survive restarts.

### 1.6 Invite Token Lifecycle

One-time-use tokens with hash-only storage, TTL expiry, and consumption
tracking.

| System | Store | TTL | Max Uses |
|--------|-------|-----|----------|
| A2A | `assistant_ingress_invites` table (via `ingress-invite-store`) | 24h (default) | 1 |
| Ingress invites | `assistant_ingress_invites` table | 7d (default) | Configurable |
| Device pairing | `PairingStore` (in-memory + JSON file) | 5m | 1 |

A2A already reuses the `ingress-invite-store` for its invite tokens --
this is an existing convergence point. Device pairing uses its own
in-memory store because QR pairing tokens have very short lifetimes and
the approval flow is tightly coupled to IPC events.

### 1.7 State Machine Transitions

Both systems model a multi-phase handshake with explicit state transitions
and guards.

| System | States | Transition Style | Key Files |
|--------|--------|-----------------|-----------|
| A2A | `awaiting_request` -> `awaiting_approval` -> `awaiting_verification` -> `verified` -> `active` | Pure functions returning `TransitionResult` discriminated union | `a2a/a2a-handshake.ts`, `a2a/a2a-peer-connection-store.ts`, `a2a/a2a-connection-service.ts` |
| Device pairing | `registered` -> `pending` -> `approved` / `denied` / `expired` | Mutable methods on `PairingStore` class | `daemon/pairing-store.ts`, `runtime/routes/pairing-routes.ts` |

The A2A state machine is more complex (5 states, identity binding,
attempt tracking, credential exchange) while device pairing is simpler
(3 active states, secret-gated, no verification code exchange). They share
the concept of guardian approval as a gate but differ in every detail.

---

## 2. Candidates for Extraction

Based on the catalog above, the following primitives are candidates for
extraction into a shared `util/crypto-primitives.ts` (or similar) module:

### 2.1 Strong Candidates (trivial, zero-risk)

| Primitive | Current Duplicates | Proposed Location |
|-----------|--------------------|-------------------|
| `hashSecret(input): string` | 7 implementations | `util/crypto-primitives.ts` |
| `timingSafeCompare(a, b): boolean` | 2 implementations | `util/crypto-primitives.ts` |
| `generateNumericCode(digits): string` | 3 implementations | `util/crypto-primitives.ts` |

These are pure functions with no dependencies, no state, and identical
semantics across all callsites. Extraction is a mechanical refactor.

### 2.2 Weak Candidates (non-trivial, context-dependent)

| Pattern | Why Not Extract |
|---------|-----------------|
| TTL sweep logic | Each system uses a different sweep strategy (timer vs. opportunistic vs. query-time) because the data shapes and volumes differ. A shared abstraction would need to be parameterized to the point where it adds complexity rather than removing it. |
| Rate limiting | The A2A rate limiter (in-memory sliding window) and guardian rate limiter (DB-backed lockout) serve different persistence requirements. Converging them would force one system to adopt an inappropriate storage model. |
| State machine transitions | The A2A handshake has 5 states with identity binding, attempt counting, and credential exchange. Device pairing has 3 states with secret validation. The overlap is structural (both are state machines) but not substantial enough to warrant a shared framework. |
| Invite token lifecycle | A2A already reuses `ingress-invite-store`. Device pairing uses an entirely different storage model (in-memory + JSON file) because pairing tokens are ultra-short-lived and bound to the IPC approval UI. Forcing pairing through the DB invite store would add unnecessary complexity and latency. |

### 2.3 Not Candidates

| Pattern | Why |
|---------|-----|
| HMAC-SHA256 signing/verification (A2A peer auth) | Unique to A2A -- device pairing has no equivalent. Pairing uses shared-secret validation, not request-level signing. |
| Nonce tracking / replay protection | Unique to A2A post-handshake communication. Device pairing does not have a post-handshake message channel. |
| Credential rotation / revocation | Unique to A2A long-lived connections. Device pairing issues one-time bearer tokens. |
| Scope model | Unique to A2A. Device pairing grants full access or no access. |

---

## 3. Risk / Benefit Assessment

### Benefits of Convergence (Strong Candidates Only)

- **Reduced duplication**: Eliminates 7 independent `createHash('sha256')` wrappers and 3 independent numeric code generators. New callsites import from one place.
- **Single security audit point**: Any future change to the hashing scheme (e.g., adding salt, switching to BLAKE3) happens in one file.
- **Discoverability**: New contributors find the canonical crypto primitives in one well-documented module instead of scattered across 7 files.

### Risks

- **Coupling blast radius**: If the shared module has a bug, it affects both A2A and pairing simultaneously. Mitigated by the fact that these are trivially correct pure functions with existing test coverage on both sides.
- **Import graph complexity**: The shared module must be importable from all consumers without creating circular dependencies. `util/` is already a leaf-level module with no inward dependencies, so placing the shared primitives there is safe.
- **Migration churn**: Renaming imports across ~15 files touches many modules. Mitigated by automated refactoring and the fact that the function signatures are identical.

### Net Assessment

**Low risk, moderate benefit.** The strong candidates are trivially correct
pure functions where convergence reduces surface area without adding
abstraction overhead. The weak candidates are not worth converging because
the apparent duplication is superficial -- the implementations serve
different operational requirements.

---

## 4. Recommendation

**Converge the strong candidates now. Leave everything else separate.**

The three pure-function primitives (SHA-256 hashing, timing-safe comparison,
numeric code generation) should be extracted into a shared utility module.
The remaining patterns (TTL sweeps, rate limiting, state machines, invite
lifecycle) should remain in their domain-specific implementations because
the apparent duplication masks genuine differences in requirements.

This is consistent with the project's Extensibility Principle: extract
reusable building blocks, but don't force convergence when the abstraction
would be more complex than the duplication.

---

## 5. Phased Convergence Plan

### Phase 1: Create Shared Crypto Primitives Module (Low Risk)

**Scope**: Create `assistant/src/util/crypto-primitives.ts` exporting:
- `hashSecret(input: string): string` -- SHA-256 hex digest
- `timingSafeCompare(a: string, b: string): boolean` -- constant-time hex comparison
- `generateNumericCode(digits?: number): string` -- cryptographic random N-digit code

**Steps**:
1. Create `util/crypto-primitives.ts` with the three functions.
2. Add unit tests in `util/__tests__/crypto-primitives.test.ts`.
3. Ship as a standalone PR. No existing code changes yet.

**Rollback**: Delete the file. No dependents yet.

### Phase 2: Migrate A2A Consumers (Low Risk)

**Scope**: Update A2A modules to import from the shared module.

**Files affected**:
- `a2a/a2a-handshake.ts`: Replace `hashHandshakeSecret` and `timingSafeCompare` with imports from `util/crypto-primitives`. Re-export for backward compatibility.
- `a2a/a2a-handshake.ts`: Replace `generateVerificationCode` with `generateNumericCode`. Re-export for backward compatibility.
- `a2a/a2a-peer-auth.ts`: Update `hashHandshakeSecret` import path.

**Backward compatibility**: The existing exports from `a2a-handshake.ts` remain as re-exports so downstream imports do not break. Deprecation comments guide future callers to the canonical location.

**Rollback**: Revert the import changes. The shared module is unused but harmless.

### Phase 3: Migrate Pairing and Guardian Consumers (Low Risk)

**Scope**: Update non-A2A modules to import from the shared module.

**Files affected**:
- `daemon/pairing-store.ts`: Remove local `hashValue` and `timingSafeCompare`, import from `util/crypto-primitives`.
- `daemon/approved-devices-store.ts`: Remove local `hashDeviceId`, import `hashSecret` and alias.
- `runtime/channel-guardian-service.ts`: Remove local `hashSecret` and `generateNumericSecret`, import from `util/crypto-primitives`.
- `util/voice-code.ts`: Remove `hashVoiceCode` and `generateVoiceCode`, re-export from `util/crypto-primitives` for backward compatibility.
- `memory/ingress-invite-store.ts`: Remove local `hashToken`, import `hashSecret` and alias.

**Rollback**: Revert the import changes per file. Each file is independent.

### Phase 4: Remove Deprecated Re-exports (Deferred)

**Scope**: After all consumers have migrated, remove re-exports from
`a2a-handshake.ts`, `voice-code.ts`, etc. This is a cleanup step that can
happen at any future point when the re-exports are no longer referenced.

**This phase has no deadline.** The re-exports impose zero runtime cost.

---

## 6. What NOT to Converge

For clarity, the following items are explicitly out of scope and should
remain as separate, domain-specific implementations:

| Pattern | Rationale |
|---------|-----------|
| A2A `NonceStore` / `MessageDedupStore` | Purpose-built for replay protection in long-lived peer connections. Pairing has no equivalent need. |
| A2A `A2ARateLimiter` | In-memory sliding window suited to ephemeral A2A handshake traffic. Guardian rate limiting is DB-backed for persistence across restarts. Different requirements, different implementations. |
| A2A handshake state machine | 5-state machine with identity binding, credential exchange, and attempt tracking. Structurally different from the 3-state pairing flow. A shared "state machine framework" would be over-engineering. |
| `PairingStore` (in-memory + JSON) | The pairing store's storage model (in-memory Map + periodic JSON persistence) is fundamentally different from A2A's SQLite-backed connection store. The apparent similarity (both track handshake state) masks a deep difference in lifetime, persistence, and access pattern requirements. |
| HMAC-SHA256 request signing | Unique to A2A post-handshake authentication. Device pairing uses one-time bearer tokens. No convergence surface. |
| Scope model / policy evaluation | Unique to A2A's per-connection capability model. Device pairing has binary access (paired or not). |

---

## 7. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-03 | Recommend converging only pure crypto primitives | Risk/benefit favors extracting trivially correct pure functions; other patterns have divergent requirements |
| 2026-03-03 | Do NOT converge state machines, rate limiters, or storage patterns | Surface-level similarity masks deep differences in persistence, lifecycle, and trust model requirements |
| 2026-03-03 | Use `util/crypto-primitives.ts` as the shared module location | Consistent with existing `util/` convention; leaf-level module avoids circular dependency risk |
