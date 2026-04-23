/**
 * Registry for skill-provided HTTP route handlers.
 *
 * Skills and plugins register route matchers + handlers at initialization
 * time. The runtime HTTP server checks the registry for each inbound request
 * before falling through to its own route table.
 *
 * Registrations are identified by an opaque {@link SkillRouteHandle} returned
 * from {@link registerSkillRoute}. Callers must pass that exact handle back
 * to {@link unregisterSkillRoute} to remove the registration — pattern text
 * is intentionally not a stable key, because two owners can legitimately
 * register the same regex, and keying on `source + flags` would let one
 * owner's teardown silently drop another owner's route.
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

/**
 * Opaque token returned from {@link registerSkillRoute}. The token has no
 * observable fields — callers must treat it as a black box whose only valid
 * use is to pass it to {@link unregisterSkillRoute}. Identity comparison on
 * the token is what the registry keys against, so every call to
 * `registerSkillRoute` returns a fresh handle even when the route's
 * `pattern`/`methods`/`handler` are deep-equal to an existing entry.
 */
declare const skillRouteHandleBrand: unique symbol;
export interface SkillRouteHandle {
  readonly [skillRouteHandleBrand]: true;
}

interface RegisteredRoute {
  readonly handle: SkillRouteHandle;
  readonly route: SkillRoute;
}

const routes: RegisteredRoute[] = [];

/**
 * Register a skill- or plugin-provided HTTP route. Called at initialization
 * time. Returns an opaque handle the caller must retain and pass back to
 * {@link unregisterSkillRoute} at teardown time. Do not attempt to derive
 * the handle from the route's pattern — identity is the only stable key.
 */
export function registerSkillRoute(route: SkillRoute): SkillRouteHandle {
  const handle = Object.freeze({}) as SkillRouteHandle;
  routes.push({ handle, route });
  log.info(
    { pattern: route.pattern.source, methods: route.methods },
    "Skill route registered",
  );
  return handle;
}

/**
 * Unregister a previously-registered skill route by handle.
 *
 * Returns `true` if a route was removed, `false` otherwise. Not finding a
 * match is not an error: the plugin-shutdown path calls this best-effort for
 * every handle a plugin retained, and a stale handle (e.g. the registry was
 * cleared externally) should not crash shutdown.
 */
export function unregisterSkillRoute(handle: SkillRouteHandle): boolean {
  const index = routes.findIndex((entry) => entry.handle === handle);
  if (index === -1) {
    log.warn({}, "unregisterSkillRoute: no matching route found for handle");
    return false;
  }
  const [removed] = routes.splice(index, 1);
  log.info(
    { pattern: removed!.route.pattern.source },
    "Skill route unregistered",
  );
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
  for (const entry of routes) {
    const match = path.match(entry.route.pattern);
    if (!match) continue;
    if (entry.route.methods.includes(method)) {
      return { kind: "match", route: entry.route, match };
    }
    pathMatches.push(entry.route);
  }
  if (pathMatches.length === 0) return null;
  const allow = Array.from(new Set(pathMatches.flatMap((r) => r.methods)));
  return { kind: "methodMismatch", allow };
}

/**
 * Test-only helper — drops every registered route. Production code has no
 * legitimate need for this; a real shutdown walks the handles each owner
 * retained. Exported so tests that bypass the normal shutdown path (e.g.
 * those that crash mid-bootstrap) can reset registry state between cases.
 */
export function resetSkillRoutesForTests(): void {
  routes.length = 0;
}
