/**
 * Filters the ROUTES array down to IPC-eligible routes and appends the
 * meta-route used by the gateway for IPC proxy discovery.
 */

import { getPolicy } from "../../runtime/auth/route-policy.js";
import type { RouteDefinition } from "../../runtime/routes/types.js";

function isIpcEligible(r: RouteDefinition): boolean {
  return !r.requireGuardian && !r.isPublic;
}

/**
 * Derive the policy key for a route. Mirrors the HTTP router's logic:
 * use the explicit `policyKey` when present, otherwise strip path params
 * from the endpoint (e.g. `calls/:id/cancel` → `calls/cancel`).
 */
function resolvePolicyKey(r: RouteDefinition): string | undefined {
  if (!r.requirePolicyEnforcement) return undefined;
  if (r.policyKey) return r.policyKey;
  return r.endpoint
    .split("/")
    .filter((s) => !s.startsWith(":"))
    .join("/");
}

/**
 * Resolve the policy for a route. Mirrors the HTTP router's method-specific
 * fallback: try `policyKey:METHOD` first, then plain `policyKey`.
 */
function resolvePolicy(
  r: RouteDefinition,
): { scopes: string[]; principalTypes: string[] } | undefined {
  const baseKey = resolvePolicyKey(r);
  if (!baseKey) return undefined;

  const methodKey = `${baseKey}:${r.method}`;
  const policy = getPolicy(methodKey) ?? getPolicy(baseKey);
  if (!policy) return undefined;

  return {
    scopes: [...policy.requiredScopes],
    principalTypes: [...policy.allowedPrincipalTypes],
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
    handler: async () =>
      eligible.map((r) => ({
        operationId: r.operationId,
        endpoint: r.endpoint,
        method: r.method,
        policy: resolvePolicy(r),
      })),
  };

  return [...eligible, metaRoute];
}
