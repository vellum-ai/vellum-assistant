/**
 * Adapts transport-agnostic RouteDefinitions into HTTPRouteDefinitions
 * for the HTTP server's route table.
 */

import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { NotFoundError } from "./errors.js";
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
      try {
        const result = await r.handler();
        return Response.json(result);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return httpError("NOT_FOUND", err.message, 404);
        }
        throw err;
      }
    },
  }));
}
