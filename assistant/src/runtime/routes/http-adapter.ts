/**
 * Adapts transport-agnostic RouteDefinitions into HTTPRouteDefinitions
 * for the HTTP server's route table.
 */

import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import {
  BadRequestError,
  ConflictError,
  FailedDependencyError,
  NotFoundError,
  RouteError,
  ServiceUnavailableError,
} from "./errors.js";
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
    queryParams: r.queryParams,
    requestBody: r.requestBody,
    responseBody: r.responseBody,
    handler: async ({ req, url, params }) => {
      try {
        const merged: Record<string, unknown> = { ...params };

        for (const [key, value] of url.searchParams.entries()) {
          merged[key] = value;
        }

        if (
          r.method === "POST" ||
          r.method === "PUT" ||
          r.method === "PATCH"
        ) {
          try {
            const body = (await req.json()) as Record<string, unknown>;
            if (body && typeof body === "object") {
              Object.assign(merged, body);
            }
          } catch {
            // No body or invalid JSON — handler will validate
          }
        }

        const result = await r.handler(
          Object.keys(merged).length > 0 ? merged : undefined,
        );
        return Response.json(result);
      } catch (err) {
        if (err instanceof BadRequestError) {
          return httpError("BAD_REQUEST", err.message, 400);
        }
        if (err instanceof NotFoundError) {
          return httpError("NOT_FOUND", err.message, 404);
        }
        if (err instanceof ConflictError) {
          return httpError("CONFLICT", err.message, 409);
        }
        if (err instanceof FailedDependencyError) {
          return httpError("FAILED_DEPENDENCY", err.message, 424);
        }
        if (err instanceof ServiceUnavailableError) {
          return httpError("SERVICE_UNAVAILABLE", err.message, 503);
        }
        if (err instanceof RouteError) {
          return httpError("INTERNAL_ERROR", err.message, 500);
        }
        throw err;
      }
    },
  }));
}
