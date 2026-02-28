/**
 * Actor-token verification middleware for HTTP routes.
 *
 * Extracts the X-Actor-Token header, verifies the HMAC signature,
 * checks that the token is active in the store, and returns the
 * verified claims and resolved guardian runtime context.
 *
 * Used by vellum-channel HTTP routes (POST /v1/messages, POST /v1/confirm,
 * POST /v1/guardian-actions/decision, etc.) to enforce identity-based
 * authentication after the M5 cutover.
 *
 * For backward compatibility with bearer-authenticated local clients (CLI),
 * provides fallback functions that resolve identity through the local IPC
 * guardian context pathway when no actor token is present.
 */

import type { ChannelId } from '../../channels/types.js';
import type { GuardianRuntimeContext } from '../../daemon/session-runtime-assembly.js';
import { getActiveBinding } from '../../memory/guardian-bindings.js';
import { getLogger } from '../../util/logger.js';
import { type ActorTokenClaims, hashToken, verifyActorToken } from '../actor-token-service.js';
import { findActiveByTokenHash } from '../actor-token-store.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../assistant-scope.js';
import {
  resolveGuardianContext,
  toGuardianRuntimeContext,
} from '../guardian-context-resolver.js';
import { resolveLocalIpcGuardianContext } from '../local-actor-identity.js';

const log = getLogger('actor-token-middleware');

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
 * Steps:
 * 1. Extract the header value.
 * 2. Verify HMAC signature and expiration.
 * 3. Check the token hash is active in the actor-token store.
 * 4. Resolve a guardian context through the standard trust pipeline using
 *    the claims' guardianPrincipalId as the sender identity.
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

  // Structural + signature verification
  const verifyResult = verifyActorToken(rawToken);
  if (!verifyResult.ok) {
    log.warn({ reason: verifyResult.reason }, 'Actor token verification failed');
    return {
      ok: false,
      status: 401,
      message: `Invalid actor token: ${verifyResult.reason}`,
    };
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

  const { claims } = verifyResult;

  // Resolve guardian context through the shared trust pipeline.
  // The guardianPrincipalId from the token is used as the sender identity,
  // and 'vellum' is used as the channel for binding lookup.
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const guardianCtx = resolveGuardianContext({
    assistantId,
    sourceChannel: 'vellum',
    externalChatId: 'local',
    senderExternalUserId: claims.guardianPrincipalId,
  });

  const guardianContext = toGuardianRuntimeContext('vellum' as ChannelId, guardianCtx);

  return {
    ok: true,
    claims,
    guardianContext,
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
 * When absent, the request has already passed bearer token auth in the
 * HTTP server layer, meaning it is from a trusted local client (e.g. CLI).
 * In that case, we fall back to `resolveLocalIpcGuardianContext()` which
 * produces the same guardian context as the IPC pathway.
 *
 * This preserves backward compatibility with the CLI, which sends only
 * `Authorization: Bearer <token>` without `X-Actor-Token`.
 */
export function verifyHttpActorTokenWithLocalFallback(
  req: Request,
): ActorTokenVerificationWithFallback {
  const rawToken = extractActorToken(req);

  // If an actor token is present, use the strict verification pipeline.
  if (rawToken) {
    return verifyHttpActorToken(req);
  }

  // No actor token — this request passed bearer auth at the HTTP server
  // level, so it is from a local trusted client. Resolve identity the
  // same way as IPC connections.
  log.debug('No actor token present on bearer-authenticated request; using local IPC identity fallback');
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
