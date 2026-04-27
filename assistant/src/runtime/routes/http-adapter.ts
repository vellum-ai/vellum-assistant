/**
 * Adapts transport-agnostic RouteDefinitions into HTTPRouteDefinitions
 * for the HTTP server's route table.
 */

import type { HttpErrorCode } from "../http-errors.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { RouteError } from "./errors.js";
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
        const queryParams: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryParams[key] = value;
        }

        const pathParams: Record<string, unknown> = {
          ...params,
          ...queryParams,
        };

        let body: Record<string, unknown> | undefined;
        if (
          r.method === "POST" ||
          r.method === "PUT" ||
          r.method === "PATCH"
        ) {
          try {
            const parsed = (await req.json()) as Record<string, unknown>;
            if (parsed && typeof parsed === "object") {
              body = parsed;
            }
          } catch {
            // No body or invalid JSON — handler will validate
          }
        }

        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const result = await r.handler({ params: pathParams, body, headers });
        return Response.json(result);
      } catch (err) {
        if (err instanceof RouteError) {
          return httpError(
            err.code as HttpErrorCode,
            err.message,
            err.statusCode,
          );
        }
        throw err;
      }
    },
  }));
}
