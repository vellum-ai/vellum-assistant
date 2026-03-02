/**
 * JWT bearer auth middleware for the runtime HTTP server.
 *
 * Extracts `Authorization: Bearer <token>`, verifies the JWT with
 * `aud=vellum-daemon`, and builds an AuthContext from the claims.
 *
 * Replaces both the legacy bearer shared-secret check and the
 * actor-token HMAC middleware with a single JWT verification path.
 *
 * In dev mode (DISABLE_HTTP_AUTH + VELLUM_UNSAFE_AUTH_BYPASS), JWT
 * verification is skipped and a synthetic AuthContext is constructed
 * so downstream code always has a typed context to consume.
 */

import { isHttpAuthDisabled } from '../../config/env.js';
import { getLogger } from '../../util/logger.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../assistant-scope.js';
import { extractBearerToken } from '../middleware/auth.js';
import { buildAuthContext } from './context.js';
import { resolveScopeProfile } from './scopes.js';
import { verifyToken } from './token-service.js';
import type { AuthContext } from './types.js';

const log = getLogger('auth-middleware');

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type AuthenticateResult =
  | { ok: true; context: AuthContext }
  | { ok: false; response: Response };

// ---------------------------------------------------------------------------
// Dev bypass synthetic context
// ---------------------------------------------------------------------------

/**
 * Construct a synthetic AuthContext for dev mode when auth is bypassed.
 * Grants the broadest profile so all routes are accessible during
 * local development.
 */
function buildDevBypassContext(): AuthContext {
  return {
    subject: `actor:${DAEMON_INTERNAL_ASSISTANT_ID}:dev-bypass`,
    principalType: 'actor',
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    actorPrincipalId: 'dev-bypass',
    scopeProfile: 'actor_client_v1',
    scopes: resolveScopeProfile('actor_client_v1'),
    policyEpoch: Number.MAX_SAFE_INTEGER,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming HTTP request via JWT bearer token.
 *
 * Returns an AuthContext on success, or an error Response on failure.
 * The caller should return the error Response directly to the client.
 */
export function authenticateRequest(req: Request): AuthenticateResult {
  // Dev bypass: skip JWT verification entirely
  if (isHttpAuthDisabled()) {
    return { ok: true, context: buildDevBypassContext() };
  }

  const path = new URL(req.url).pathname;

  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    log.warn({ reason: 'missing_token', path }, 'Auth denied: missing Authorization header');
    return {
      ok: false,
      response: Response.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' } },
        { status: 401 },
      ),
    };
  }

  // Verify the JWT with audience = vellum-daemon
  const verifyResult = verifyToken(rawToken, 'vellum-daemon');
  if (!verifyResult.ok) {
    // Stale policy epoch gets a specific error code so clients can refresh
    if (verifyResult.reason === 'stale_policy_epoch') {
      log.warn({ reason: 'stale_policy_epoch', path }, 'Auth denied: stale policy epoch');
      return {
        ok: false,
        response: Response.json(
          { error: { code: 'refresh_required', message: 'Token policy epoch is stale; refresh required' } },
          { status: 401 },
        ),
      };
    }

    log.warn({ reason: verifyResult.reason, path }, 'Auth denied: JWT verification failed');
    return {
      ok: false,
      response: Response.json(
        { error: { code: 'UNAUTHORIZED', message: `Invalid token: ${verifyResult.reason}` } },
        { status: 401 },
      ),
    };
  }

  // Build normalized AuthContext from verified claims
  const contextResult = buildAuthContext(verifyResult.claims);
  if (!contextResult.ok) {
    log.warn(
      { reason: contextResult.reason, path, sub: verifyResult.claims.sub },
      'Auth denied: invalid JWT claims',
    );
    return {
      ok: false,
      response: Response.json(
        { error: { code: 'UNAUTHORIZED', message: `Invalid token claims: ${contextResult.reason}` } },
        { status: 401 },
      ),
    };
  }

  return { ok: true, context: contextResult.context };
}
