/**
 * Adapts transport-agnostic RouteDefinitions into HTTPRouteDefinitions
 * for the HTTP server's route table.
 */

import { requireBoundGuardian } from "../auth/require-bound-guardian.js";
import type { HttpErrorCode } from "../http-errors.js";
import { httpError } from "../http-errors.js";
import type { HTTPRouteDefinition } from "../http-router.js";
import { RouteError } from "./errors.js";
import type { ResponseHeaderArgs, RouteDefinition } from "./types.js";

function resolveResponseHeaders(
  spec: RouteDefinition["responseHeaders"],
  args: ResponseHeaderArgs,
): Record<string, string> | undefined {
  if (!spec) return undefined;
  if (typeof spec === "function") return spec(args);
  return spec;
}

export function routeDefinitionsToHTTPRoutes(
  routes: RouteDefinition[],
): HTTPRouteDefinition[] {
  return routes.map((r) => ({
    endpoint: r.endpoint,
    method: r.method,
    policyKey:
      r.policyKey ??
      r.endpoint.replace(/\/:[^/]+/g, "").replace(/^:/, ""),
    summary: r.summary,
    description: r.description,
    tags: r.tags,
    queryParams: r.queryParams,
    requestBody: r.requestBody,
    responseBody: r.responseBody,
    responseStatus: r.responseStatus,
    additionalResponses: r.additionalResponses,
    handler: async ({ req, url, params, authContext }) => {
      try {
        if (r.requireGuardian) {
          const guardianError = requireBoundGuardian(authContext);
          if (guardianError) return guardianError;
        }

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
        if (r.method === "POST" || r.method === "PUT" || r.method === "PATCH" || r.method === "DELETE") {
          if (contentType.includes("application/json") || contentType === "") {
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

        // Inject auth context fields so transport-agnostic handlers can
        // resolve trust context without importing auth internals.
        if (authContext?.actorPrincipalId) {
          headers["x-vellum-actor-principal-id"] =
            authContext.actorPrincipalId;
        }
        if (authContext?.principalType) {
          headers["x-vellum-principal-type"] = authContext.principalType;
        }

        const result = await r.handler({
          pathParams,
          queryParams,
          body,
          rawBody,
          headers,
          abortSignal: req.signal,
        });

        // Handlers that need full HTTP control (e.g. Range/206 responses)
        // may return a Response directly — pass it through unchanged.
        if (result instanceof Response) {
          return result;
        }

        const responseHeaders = resolveResponseHeaders(r.responseHeaders, {
          pathParams,
          queryParams,
          headers,
        });

        const status = r.responseStatus ? Number(r.responseStatus) : 200;

        // 204 No Content — discard handler result, return empty body
        if (status === 204) {
          return new Response(null, { status: 204, headers: responseHeaders });
        }

        // Non-JSON responses: handler returned string, Uint8Array, or ReadableStream
        if (
          typeof result === "string" ||
          result instanceof Uint8Array ||
          result instanceof ReadableStream
        ) {
          return new Response(result as BodyInit, {
            status,
            headers: responseHeaders,
          });
        }

        // JSON responses: use responseHeaders if specified, otherwise default
        return Response.json(result, {
          status,
          headers: responseHeaders,
        });
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
