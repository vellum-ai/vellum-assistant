/**
 * Filters the ROUTES array down to IPC-eligible routes and appends the
 * meta-route used by the gateway for IPC proxy discovery.
 *
 * The schema includes each route's policy verbatim — the gateway's
 * IPC proxy enforces equivalent scope/principal checks without
 * maintaining a parallel table. The policy is a property of each
 * RouteDefinition; no lookup or derivation happens here.
 */

import type { RouteDefinition } from "../../runtime/routes/types.js";

function isIpcEligible(r: RouteDefinition): boolean {
  return !r.requireGuardian && !r.isPublic;
}

/**
 * Wire-shape entry returned by `get_route_schema`. Matches the gateway's
 * `RouteSchemaEntry` (see `gateway/src/ipc/route-schema-cache.ts`).
 *
 * `policy: null` means the daemon has explicitly registered the route as
 * unprotected (e.g. health, debug). The gateway respects that and
 * skips enforcement. `policy: { ... }` carries the same scopes /
 * principal types the daemon's HTTP path enforces via `enforcePolicy()`.
 */
interface IpcRouteSchemaEntry {
  operationId: string;
  endpoint: string;
  method: string;
  policy: {
    requiredScopes: string[];
    allowedPrincipalTypes: string[];
  } | null;
}

function toSchemaEntry(r: RouteDefinition): IpcRouteSchemaEntry {
  return {
    operationId: r.operationId,
    endpoint: r.endpoint,
    method: r.method,
    policy: r.policy
      ? {
          // Spread into mutable string[] for serialization — the wire
          // shape doesn't carry the `Scope` / `PrincipalType` narrowing.
          requiredScopes: [...r.policy.requiredScopes],
          allowedPrincipalTypes: [...r.policy.allowedPrincipalTypes],
        }
      : null,
  };
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
    // The IPC route schema endpoint is the gateway's bootstrap call —
    // it runs before any policy table is in scope and has no actor
    // scopes attached. Explicitly unprotected.
    policy: null,
    handler: async () => eligible.map(toSchemaEntry),
  };

  return [...eligible, metaRoute];
}
