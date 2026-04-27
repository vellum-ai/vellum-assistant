/**
 * Adapts transport-agnostic RouteDefinitions into HTTPRouteDefinitions
 * for the HTTP server's route table.
 */

import type { HttpErrorCode } from "../http-errors.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { RouteError } from "./errors.js";
import type { RouteDefinition } from "./types.js";
import { isRouteResponse } from "./types.js";

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
        const pathParams: Record<string, string> = {};
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            pathParams[key] = String(value);
          }
        }

        const queryParams: Record<string, string> = {};
        for (const [key, value] of url.searchParams.entries()) {
          queryParams[key] = value;
        }

        const contentType = req.headers.get("content-type") ?? "";
        let body: Record<string, unknown> | undefined;
        let rawBody: Uint8Array | undefined;
        if (
          r.method === "POST" ||
          r.method === "PUT" ||
          r.method === "PATCH"
        ) {
          if (
            contentType.includes("application/json") ||
            contentType === ""
          ) {
            try {
              const parsed = (await req.json()) as Record<string, unknown>;
              if (parsed && typeof parsed === "object") {
                body = parsed;
              }
            } catch {
              // No body or invalid JSON — handler will validate
            }
          } else {
            // Binary body (e.g. application/zip, application/octet-stream)
            rawBody = new Uint8Array(await req.arrayBuffer());
          }
        }

        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const result = await r.handler({
          pathParams,
          queryParams,
          body,
          rawBody,
          headers,
        });

        if (isRouteResponse(result)) {
          return new Response(result.body as BodyInit, {
            headers: result.headers,
          });
        }
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
