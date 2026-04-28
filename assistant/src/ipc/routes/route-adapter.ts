/**
 * Filters the ROUTES array down to IPC-eligible routes and appends the
 * meta-route used by the gateway for IPC proxy discovery.
 */

import type { RouteDefinition } from "../../runtime/routes/types.js";

function isIpcEligible(r: RouteDefinition): boolean {
  return !r.requireGuardian && !r.isPublic && !r.requirePolicyEnforcement;
}

export function routeDefinitionsToIpcMethods(
  routes: RouteDefinition[],
): RouteDefinition[] {
  const eligible = routes.filter(isIpcEligible);

  // Meta-route: exposes the route schema to the gateway for IPC proxy
  // discovery. Lives here (not in ROUTES) because it describes ROUTES itself.
  const metaRoute: RouteDefinition = {
    operationId: "get_route_schema",
    method: "GET",
    endpoint: "_internal/route-schema",
    handler: async () =>
      eligible.map((r) => ({
        operationId: r.operationId,
        endpoint: r.endpoint,
        method: r.method,
      })),
  };

  return [...eligible, metaRoute];
}
