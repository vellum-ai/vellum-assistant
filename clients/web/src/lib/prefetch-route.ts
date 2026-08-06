/**
 * Warm the lazy chunks a path will need, before anything navigates to it.
 *
 * Route components are code-split (`lazy: { Component: () => import(...) }` in
 * `routes.tsx`), so a navigation to a path whose chunk is not resolved yet
 * cannot commit until the network round trip finishes. Nothing paints during
 * that window, which is most visible behind an animated transition: the
 * outgoing view is already gone and the incoming one does not exist.
 *
 * Calling this ahead of the navigation moves the fetch off the critical path.
 * The dynamic imports are idempotent and module-cached by the bundler, so an
 * already-resolved chunk costs nothing and a warmed path is skipped outright.
 *
 * Best-effort by contract: a failure here must never surface, because the real
 * navigation will request the same chunk again and own the error handling.
 */

import { matchRoutes } from "react-router";

/** Paths whose chunks have already been requested. */
const warmed = new Set<string>();

/** The `lazy` shapes a route may carry: a single loader or one per property. */
type LazyRouteValue =
  (() => Promise<unknown>) | Record<string, () => Promise<unknown>>;

function warmLazy(lazy: LazyRouteValue): void {
  if (typeof lazy === "function") {
    void lazy().catch(() => {});
    return;
  }
  for (const load of Object.values(lazy)) {
    if (typeof load === "function") {
      void load().catch(() => {});
    }
  }
}

/**
 * Request every lazy chunk on the route branch matching `href`. Safe to call
 * repeatedly and from event handlers; it never throws and never awaits.
 */
export function prefetchRoute(href: string | undefined): void {
  if (!href || warmed.has(href)) {
    return;
  }
  warmed.add(href);

  // `routes.tsx` builds the router out of the whole component tree, so a
  // static import here would be a cycle. The same lazy-import escape hatch
  // `auth-middleware.ts` uses for the router.
  void import("@/routes")
    .then(({ routeTree }) => {
      const matches = matchRoutes(routeTree as never, href);
      for (const match of matches ?? []) {
        const lazy = (match.route as { lazy?: LazyRouteValue }).lazy;
        if (lazy) {
          warmLazy(lazy);
        }
      }
    })
    .catch(() => {
      // Let a later call retry rather than leaving the path marked warm.
      warmed.delete(href);
    });
}

/** @internal Exposed for test isolation only. */
export function resetPrefetchedRoutes(): void {
  warmed.clear();
}
