/**
 * Actor-token verification middleware for HTTP routes.
 *
 * Extracts the X-Actor-Token header, verifies the token (JWT or legacy HMAC),
 * checks that the token is active in the store, and returns the
 * verified claims and resolved guardian runtime context.
 *
 * Used by vellum-channel HTTP routes (POST /v1/messages, POST /v1/confirm,
 * POST /v1/guardian-actions/decision, etc.) to enforce identity-based
 * authentication.
 *
 * For backward compatibility with bearer-authenticated local clients (CLI),
 * provides fallback functions that resolve identity through the local IPC
 * guardian context pathway when no actor token is present.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { GuardianRuntimeContext } from '../../daemon/session-runtime-assembly.js';
import { getActiveBinding } from '../../memory/guardian-bindings.js';
import { getLogger } from '../../util/logger.js';
import { findActiveByTokenHash } from '../actor-token-store.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../assistant-scope.js';
import { parseSub } from '../auth/subject.js';
import { hashToken, verifyToken } from '../auth/token-service.js';
import { resolveGuardianContext } from '../guardian-context-resolver.js';
import { resolveLocalIpcGuardianContext } from '../local-actor-identity.js';

const log = getLogger('actor-token-middleware');

// ---------------------------------------------------------------------------
// Legacy HMAC actor token types & verification
// ---------------------------------------------------------------------------

/**
 * Claims embedded in legacy HMAC actor tokens (pre-JWT). Retained for
 * backward compatibility during the transition period.
 */
export interface ActorTokenClaims {
  assistantId: string;
  platform: string;
  deviceId: string;
  guardianPrincipalId: string;
  iat: number;
  exp: number | null;
  jti: string;
}

type LegacyVerifyResult =
  | { ok: true; claims: ActorTokenClaims }
  | { ok: false; reason: string };

/**
 * Verify a legacy HMAC-signed actor token. Uses the same signing key
 * as the new JWT system (shared via initAuthSigningKey at startup).
 *
 * Token format: base64url(JSON claims) + '.' + base64url(HMAC-SHA256 sig)
 */
function verifyLegacyActorToken(token: string, signingKey: Buffer): LegacyVerifyResult {
  const dotIndex = token.indexOf('.');
  if (dotIndex < 0) {
    return { ok: false, reason: 'malformed_token' };
  }

  // Legacy tokens have exactly 1 dot; JWTs have 2. If there's a second dot
  // this isn't a legacy token.
  if (token.indexOf('.', dotIndex + 1) >= 0) {
    return { ok: false, reason: 'not_legacy_token' };
  }

  const payload = token.slice(0, dotIndex);
  const sigPart = token.slice(dotIndex + 1);

  const expectedSig = createHmac('sha256', signingKey)
    .update(payload)
    .digest();
  const actualSig = Buffer.from(sigPart, 'base64url');

  if (expectedSig.length !== actualSig.length) {
    return { ok: false, reason: 'invalid_signature' };
  }

  if (!timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  let claims: ActorTokenClaims;
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    claims = JSON.parse(decoded) as ActorTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed_claims' };
  }

  if (claims.exp != null && Date.now() > claims.exp) {
    return { ok: false, reason: 'token_expired' };
  }

  return { ok: true, claims };
}

// We import initAuthSigningKey indirectly — the signing key is set at startup
// and we need it for legacy verification. We expose a module-level setter.
let _legacySigningKey: Buffer | null = null;

/**
 * Set the signing key for legacy HMAC token verification.
 * Called by initAuthSigningKey in the auth module at startup.
 */
export function setLegacySigningKey(key: Buffer): void {
  _legacySigningKey = key;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActorTokenResult {
  ok: true;
  claims: ActorTokenClaims;
  guardianContext: GuardianRuntimeContext;
}

export interface ActorTokenError {
  ok: false;
  status: number;
  message: string;
}

export type ActorTokenVerification = ActorTokenResult | ActorTokenError;

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

const ACTOR_TOKEN_HEADER = 'x-actor-token';

export function extractActorToken(req: Request): string | null {
  return req.headers.get(ACTOR_TOKEN_HEADER) || null;
}

// ---------------------------------------------------------------------------
// Full verification pipeline
// ---------------------------------------------------------------------------

/**
 * Verify the X-Actor-Token header and resolve a guardian runtime context.
 *
 * Supports two token formats:
 * - **JWT (3 dot-separated parts)**: Verified via `verifyToken()` with
 *   audience `vellum-gateway` (clients present edge tokens to the runtime
 *   via the X-Actor-Token header). The `sub` claim is parsed to extract
 *   `guardianPrincipalId`.
 * - **Legacy HMAC (2 dot-separated parts)**: Verified via
 *   `verifyLegacyActorToken()` using the shared signing key.
 *
 * After format-specific verification, both paths check the token hash
 * against the active store (revocation check) and resolve a guardian
 * runtime context through the standard trust pipeline.
 *
 * Returns an ok result with claims and guardianContext, or an error with
 * the HTTP status code and message to return.
 */
export function verifyHttpActorToken(req: Request): ActorTokenVerification {
  const rawToken = extractActorToken(req);
  if (!rawToken) {
    return {
      ok: false,
      status: 401,
      message: 'Missing X-Actor-Token header. Vellum HTTP requests require actor identity.',
    };
  }

  // Determine token format by counting dot-separated parts.
  // JWT tokens have 3 parts (header.payload.signature), legacy HMAC tokens
  // have 2 parts (base64url-claims.base64url-sig).
  const dotCount = rawToken.split('.').length - 1;
  const isJwt = dotCount === 2;

  let claims: ActorTokenClaims;

  if (isJwt) {
    // --- JWT verification path ---
    const jwtResult = verifyToken(rawToken, 'vellum-gateway');
    if (!jwtResult.ok) {
      log.warn({ reason: jwtResult.reason }, 'JWT actor token verification failed');
      return {
        ok: false,
        status: 401,
        message: `Invalid actor token: ${jwtResult.reason}`,
      };
    }

    // Extract guardianPrincipalId from the sub claim
    // (format: actor:<assistantId>:<guardianPrincipalId>)
    const subResult = parseSub(jwtResult.claims.sub);
    if (!subResult.ok) {
      log.warn({ reason: subResult.reason }, 'JWT actor token has unparseable sub claim');
      return {
        ok: false,
        status: 401,
        message: `Invalid actor token: bad sub claim — ${subResult.reason}`,
      };
    }

    if (!subResult.actorPrincipalId) {
      log.warn({ sub: jwtResult.claims.sub }, 'JWT actor token sub claim missing actorPrincipalId');
      return {
        ok: false,
        status: 401,
        message: 'Invalid actor token: sub claim does not contain an actor principal ID',
      };
    }

    // Construct ActorTokenClaims-compatible object for downstream consumers
    claims = {
      assistantId: subResult.assistantId,
      platform: 'vellum',
      deviceId: '',
      guardianPrincipalId: subResult.actorPrincipalId,
      iat: (jwtResult.claims.iat ?? Math.floor(Date.now() / 1000)) * 1000,
      exp: jwtResult.claims.exp * 1000,
      jti: jwtResult.claims.jti ?? '',
    };
  } else {
    // --- Legacy HMAC verification path ---
    if (!_legacySigningKey) {
      log.error('Legacy signing key not set — cannot verify actor tokens');
      return {
        ok: false,
        status: 500,
        message: 'Server configuration error: signing key not initialized',
      };
    }

    const verifyResult = verifyLegacyActorToken(rawToken, _legacySigningKey);
    if (!verifyResult.ok) {
      log.warn({ reason: verifyResult.reason }, 'Legacy actor token verification failed');
      return {
        ok: false,
        status: 401,
        message: `Invalid actor token: ${verifyResult.reason}`,
      };
    }

    claims = verifyResult.claims;
  }

  // Check the token is active in the store (not revoked)
  const tokenHash = hashToken(rawToken);
  const record = findActiveByTokenHash(tokenHash);
  if (!record) {
    log.warn('Actor token not found in active store (possibly revoked)');
    return {
      ok: false,
      status: 401,
      message: 'Actor token is no longer active',
    };
  }

  // Resolve guardian context through the shared trust pipeline.
  // The guardianPrincipalId from the token is used as the sender identity,
  // and 'vellum' is used as the channel for binding lookup.
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const guardianCtx = resolveGuardianContext({
    assistantId,
    sourceChannel: 'vellum',
    conversationExternalId: 'local',
    actorExternalId: claims.guardianPrincipalId,
  });

  return {
    ok: true,
    claims,
    guardianContext: guardianCtx,
  };
}

/**
 * Verify that the actor identity from a verified token matches the bound
 * guardian for the vellum channel. Used for guardian-decision endpoints
 * where only the guardian should be able to approve/reject.
 *
 * Returns true if the actor is the bound guardian, false otherwise.
 */
export function isActorBoundGuardian(claims: ActorTokenClaims): boolean {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const binding = getActiveBinding(assistantId, 'vellum');
  if (!binding) return false;
  return binding.guardianExternalUserId === claims.guardianPrincipalId;
}

// ---------------------------------------------------------------------------
// Bearer-auth fallback variants
// ---------------------------------------------------------------------------

/** Loopback addresses — used to gate the local identity fallback. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Bun server shape needed for requestIP — avoids importing the full Bun type. */
export type ServerWithRequestIP = {
  requestIP(req: Request): { address: string; family: string; port: number } | null;
};

/**
 * Result for the fallback verification path where the actor token is absent
 * but the request is bearer-authenticated (local trusted client like CLI).
 */
export interface ActorTokenLocalFallbackResult {
  ok: true;
  claims: null;
  guardianContext: GuardianRuntimeContext;
  localFallback: true;
}

export type ActorTokenVerificationWithFallback =
  | ActorTokenResult
  | ActorTokenLocalFallbackResult
  | ActorTokenError;

/**
 * Verify the actor token with fallback to local IPC identity resolution.
 *
 * When an actor token is present, the full verification pipeline runs.
 * When absent AND the request originates from a loopback address, the
 * request is treated as a trusted local client (e.g. CLI) and we fall
 * back to `resolveLocalIpcGuardianContext()` which produces the same
 * guardian context as the IPC pathway.
 *
 * Two conditions must BOTH be met for the local fallback:
 * 1. No X-Forwarded-For header (rules out gateway-proxied requests).
 * 2. The peer remote address is a loopback address (rules out LAN/container
 *    connections when the runtime binds to 0.0.0.0).
 *
 * The peer address is checked via `server.requestIP(req)`.
 *
 * --- CLI compatibility note ---
 *
 * The local fallback is an intentional CLI compatibility path, not a
 * security gap. The CLI currently sends only `Authorization: Bearer <token>`
 * without `X-Actor-Token`. This fallback allows the CLI to function until
 * it is migrated to actor tokens in a future milestone.
 *
 * The fallback is gated by three conditions that together ensure only
 * genuinely local connections receive guardian identity:
 *   (1) Absence of X-Forwarded-For header — the gateway always injects
 *       this header when proxying, so its presence indicates a remote client.
 *   (2) Loopback origin check — verifies the peer IP is 127.0.0.1/::1,
 *       preventing LAN or container peers.
 *   (3) Valid bearer authentication — already enforced upstream by the
 *       HTTP server's auth gate before this function is called.
 *
 * Once the CLI adopts actor tokens, this fallback can be removed.
 */
export function verifyHttpActorTokenWithLocalFallback(
  req: Request,
  server: ServerWithRequestIP,
): ActorTokenVerificationWithFallback {
  const rawToken = extractActorToken(req);

  // If an actor token is present, use the strict verification pipeline.
  if (rawToken) {
    return verifyHttpActorToken(req);
  }

  // Gate the local fallback on provably-local origin. The gateway runtime
  // proxy always injects X-Forwarded-For with the real client IP when
  // forwarding requests. Direct local connections (CLI, macOS app) never
  // set this header. If X-Forwarded-For is present, the request was
  // proxied through the gateway on behalf of a potentially remote client
  // and must not receive local guardian identity.
  if (req.headers.get('x-forwarded-for')) {
    log.warn('Rejecting local identity fallback: request has X-Forwarded-For (proxied through gateway)');
    return {
      ok: false,
      status: 401,
      message: 'Missing X-Actor-Token header. Proxied requests require actor identity.',
    };
  }

  // Verify the peer address is actually loopback. This prevents LAN or
  // container peers from receiving local guardian identity when the
  // runtime binds to 0.0.0.0.
  const peerIp = server.requestIP(req)?.address;
  if (!peerIp || !LOOPBACK_ADDRESSES.has(peerIp)) {
    log.warn({ peerIp }, 'Rejecting local identity fallback: peer is not loopback');
    return {
      ok: false,
      status: 401,
      message: 'Missing X-Actor-Token header. Non-loopback requests require actor identity.',
    };
  }

  // No actor token, no forwarding header, and the peer is on loopback
  // — this is a direct local connection that passed bearer auth at the
  // HTTP server layer. Resolve identity the same way as IPC.
  log.debug('No actor token present on direct local request; using local IPC identity fallback');
  const guardianContext = resolveLocalIpcGuardianContext('vellum');
  return {
    ok: true,
    claims: null,
    guardianContext,
    localFallback: true,
  };
}

/**
 * Check whether the local fallback identity is the bound guardian.
 *
 * When no actor token is present (local fallback), the local user is
 * treated as the guardian of their own machine — equivalent to IPC.
 * This returns true when either the resolved trust class is 'guardian'
 * or no vellum binding exists yet (pre-bootstrap).
 */
export function isLocalFallbackBoundGuardian(): boolean {
  const guardianContext = resolveLocalIpcGuardianContext('vellum');
  return guardianContext.trustClass === 'guardian';
}
