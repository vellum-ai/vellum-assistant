/**
 * Adapts transport-agnostic RouteDefinitions into HTTPRouteDefinitions
 * for the HTTP server's route table.
 */

import type { HTTPRouteDefinition } from "../http-router.js";
import type { RouteDefinition } from "./types.js";

export function routeDefinitionsToHTTPRoutes(
  routes: RouteDefinition[],
): HTTPRouteDefinition[] {
  return routes.map((r) => ({
    endpoint: r.endpoint,
    method: r.method,
    policyKey: r.policyKey ?? r.endpoint,
    summary: r.summary,
    description: r.description,
    tags: r.tags,
    responseBody: r.responseBody,
    handler: async () => {
      const result = await r.handler();
      return Response.json(result);
    },
  }));
}
