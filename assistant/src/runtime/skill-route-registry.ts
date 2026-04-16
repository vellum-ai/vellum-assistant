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
 * Try to match an inbound request against registered skill routes.
 * Returns `null` if no route matches.
 */
export function matchSkillRoute(
  path: string,
  method: string,
): { route: SkillRoute; match: RegExpMatchArray } | null {
  for (const route of routes) {
    if (!route.methods.includes(method)) continue;
    const match = path.match(route.pattern);
    if (match) return { route, match };
  }
  return null;
}
