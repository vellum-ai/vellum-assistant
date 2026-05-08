import type { Server } from "bun";

import type { Scope } from "../auth/types.js";
import type { AuthRateLimiter } from "../auth-rate-limiter.js";
import {
  createAuthMiddleware,
  wrapWithAuthFailureTracking,
} from "./middleware/auth.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GetClientIp = () => string;

/**
 * Auth strategy for a route:
 * - "none"         — no auth check, handler called directly
 * - "edge"         — edge JWT token required (aud=vellum-gateway)
 * - "edge-scoped"  — edge JWT + scope check (requires `scope` field)
 * - "edge-guardian" — caller must be the bound vellum guardian. In the default
 *                      path, edge JWT is validated and the caller's actor
 *                      principal must match the guardian's principal id.
 *                      When DISABLE_HTTP_AUTH=true (platform-managed), the
 *                      caller is asserted via X-Vellum-User-Id forwarded by
 *                      vembda, cross-referenced with the stored
 *                      vellum:platform_user_id credential.
 * - "track-failures" — no gateway-level auth, but downstream 401s are
 *                      recorded against the rate limiter
 * - "custom"       — the handler manages auth internally
 */
type AuthStrategy =
  | "none"
  | "edge"
  | "edge-scoped"
  | "edge-guardian"
  | "track-failures"
  | "custom";

/** Params extracted from a regex path match (capture groups). */
export type RouteParams = string[];

export interface RouteDefinition {
  /** Static path string or regex pattern. Regex capture groups become `params`. */
  path: string | RegExp;
  /** HTTP method to match. Omit to match any method. */
  method?: string;
  /** Auth strategy (default: "none"). */
  auth?: AuthStrategy;
  /** Required scope when auth is "edge-scoped". */
  scope?: Scope;
  /**
   * Status codes that count as auth failures for rate limiting.
   * Only used with "track-failures" auth. Defaults to [401].
   */
  trackFailureStatuses?: readonly number[];
  /**
   * Optional precondition check. Return a Response to short-circuit,
   * or null to continue to the handler.
   */
  precondition?: () => Response | null;
  /** Route handler. Params are populated from regex capture groups. */
  handler: (
    req: Request,
    params: RouteParams,
    getClientIp: GetClientIp,
  ) => Promise<Response> | Response;
}

export interface RouterDeps {
  authRateLimiter: AuthRateLimiter;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create a router function from a declarative route table.
 *
 * The returned function matches the first route whose path and method match,
 * applies auth middleware per the route's `auth` strategy, and calls the
 * handler. Returns null if no route matches.
 */
export function createRouter(
  routes: RouteDefinition[],
  deps: RouterDeps,
): (
  req: Request,
  url: URL,
  getClientIp: GetClientIp,
  server?: Server<unknown>,
) => Promise<Response> | Response | null {
  const { authRateLimiter } = deps;

  return (
    req: Request,
    url: URL,
    getClientIp: GetClientIp,
    server?: Server<unknown>,
  ) => {
    for (const route of routes) {
      const matchResult = matchRoute(route, url.pathname, req.method);
      if (!matchResult) continue;

      // Precondition guard (e.g. "is integration configured?")
      if (route.precondition) {
        const preconditionResponse = route.precondition();
        if (preconditionResponse) return preconditionResponse;
      }

      const auth = route.auth ?? "none";

      switch (auth) {
        case "none":
        case "custom":
          return route.handler(req, matchResult.params, getClientIp);

        case "edge": {
          const { requireEdgeAuth } = createAuthMiddleware(
            authRateLimiter,
            getClientIp,
          );
          const authError = requireEdgeAuth(req, server);
          if (authError) return authError;
          return route.handler(req, matchResult.params, getClientIp);
        }

        case "edge-scoped": {
          const { requireEdgeAuthWithScope } = createAuthMiddleware(
            authRateLimiter,
            getClientIp,
          );
          const authError = requireEdgeAuthWithScope(req, route.scope!, server);
          if (authError) return authError;
          return route.handler(req, matchResult.params, getClientIp);
        }

        case "edge-guardian": {
          const { requireEdgeGuardianAuth } = createAuthMiddleware(
            authRateLimiter,
            getClientIp,
          );
          return requireEdgeGuardianAuth(req, server).then(
            (authError) =>
              authError ?? route.handler(req, matchResult.params, getClientIp),
          );
        }

        case "track-failures": {
          return wrapWithAuthFailureTracking(
            (r) => route.handler(r, matchResult.params, getClientIp),
            authRateLimiter,
            getClientIp,
            route.trackFailureStatuses,
          )(req);
        }
      }
    }

    return null;
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface MatchResult {
  params: RouteParams;
}

function matchRoute(
  route: RouteDefinition,
  pathname: string,
  method: string,
): MatchResult | null {
  // Check method first (cheapest check)
  if (route.method && route.method !== method) return null;

  if (typeof route.path === "string") {
    // Normalize trailing slashes so "/v1/foo/" matches "/v1/foo"
    const normalized =
      pathname.length > 1 && pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : pathname;
    if (normalized !== route.path) return null;
    return { params: [] };
  }

  // Regex path — use original pathname since regex routes may
  // explicitly include trailing slashes in their patterns.
  const match = pathname.match(route.path);
  if (!match) return null;
  return { params: match.slice(1) };
}
