/**
 * Registry for skill-provided HTTP route handlers.
 *
 * Skills register route matchers + handlers at initialization time. The
 * runtime HTTP server checks the registry for each inbound request before
 * falling through to its own route table.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("skill-route-registry");

export interface SkillRoute {
  /** Regex to match against the request path. Capture groups are passed to the handler. */
  pattern: RegExp;
  /** HTTP method(s) the route accepts. */
  methods: string[];
  /** Handler function. Receives the request and the regex match result. */
  handler: (req: Request, match: RegExpMatchArray) => Promise<Response>;
}

export type SkillRouteMatch =
  | { kind: "match"; route: SkillRoute; match: RegExpMatchArray }
  | { kind: "methodMismatch"; allow: string[] };

const routes: SkillRoute[] = [];

/**
 * Register a skill-provided HTTP route. Called by skills at initialization time.
 */
export function registerSkillRoute(route: SkillRoute): void {
  routes.push(route);
  log.info(
    { pattern: route.pattern.source, methods: route.methods },
    "Skill route registered",
  );
}

/**
 * Unregister a previously-registered skill route.
 *
 * Matches by `RegExp` identity first (the common case — a caller passes back
 * the same `pattern` reference it handed to {@link registerSkillRoute}) and
 * falls back to `pattern.source + flags` equality so callers that rebuild an
 * equivalent regex still succeed. Removes at most one route per call — if two
 * routes were registered with identical patterns, the first match is dropped
 * and subsequent calls remove the rest.
 *
 * Returns `true` if a route was removed, `false` otherwise. Not finding a
 * match is not an error: the plugin-shutdown path calls this best-effort for
 * every route a plugin contributed, and a stale reference (e.g. the registry
 * was cleared externally) should not crash shutdown.
 */
export function unregisterSkillRoute(pattern: RegExp): boolean {
  const index = routes.findIndex(
    (route) =>
      route.pattern === pattern ||
      (route.pattern.source === pattern.source &&
        route.pattern.flags === pattern.flags),
  );
  if (index === -1) {
    log.warn(
      { pattern: pattern.source },
      "unregisterSkillRoute: no matching route found",
    );
    return false;
  }
  routes.splice(index, 1);
  log.info({ pattern: pattern.source }, "Skill route unregistered");
  return true;
}

/**
 * Try to match an inbound request path + method against registered skill routes.
 *
 * - Returns `{ kind: "match", ... }` when a route matches both path and method.
 * - Returns `{ kind: "methodMismatch", allow }` when one or more routes match
 *   the path but none accept the method — the caller should respond with 405
 *   and an `Allow` header listing the accepted methods.
 * - Returns `null` when no route matches the path at all; the request then
 *   falls through to JWT auth and the normal route table.
 *
 * Method gating lives here so unauthenticated requests with the wrong method
 * cannot reach skill handlers, and so same-path/different-method route pairs
 * dispatch to the correct handler.
 */
export function matchSkillRoute(
  path: string,
  method: string,
): SkillRouteMatch | null {
  const pathMatches: SkillRoute[] = [];
  for (const route of routes) {
    const match = path.match(route.pattern);
    if (!match) continue;
    if (route.methods.includes(method)) {
      return { kind: "match", route, match };
    }
    pathMatches.push(route);
  }
  if (pathMatches.length === 0) return null;
  const allow = Array.from(new Set(pathMatches.flatMap((r) => r.methods)));
  return { kind: "methodMismatch", allow };
}
