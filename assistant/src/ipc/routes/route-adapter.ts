/**
 * Filters the ROUTES array down to IPC-eligible routes and appends the
 * meta-route used by the gateway for IPC proxy discovery.
 *
 * The schema includes the resolved scope/principal policy per route so
 * the gateway's IPC proxy can enforce policy without maintaining a
 * parallel table. See `resolveRoutePolicy` in `runtime/auth/route-policy.ts`
 * for the resolution rule (method-suffix key, then bare policyKey, then
 * null for intentionally unprotected routes).
 */

import { resolveRoutePolicy } from "../../runtime/auth/route-policy.js";
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
  const policy = resolveRoutePolicy({
    endpoint: r.endpoint,
    method: r.method,
    policyKey: r.policyKey,
  });

  return {
    operationId: r.operationId,
    endpoint: r.endpoint,
    method: r.method,
    policy: policy
      ? {
          // Spread into mutable string[] for serialization — the wire
          // shape doesn't carry the `Scope` / `PrincipalType` narrowing.
          requiredScopes: [...policy.requiredScopes],
          allowedPrincipalTypes: [...policy.allowedPrincipalTypes],
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
    handler: async () => eligible.map(toSchemaEntry),
  };

  return [...eligible, metaRoute];
}
