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
import { RouteResponse } from "./types.js";

function resolveResponseHeaders(
  spec: RouteDefinition["responseHeaders"],
  args: ResponseHeaderArgs,
): Record<string, string> | undefined {
  if (!spec) return undefined;
  if (typeof spec === "function") return spec(args);
  return spec;
}

function resolveResponseStatus(
  spec: RouteDefinition["responseStatus"],
  args: ResponseHeaderArgs,
): number {
  if (!spec) return 200;
  if (typeof spec === "function") return Number(spec(args));
  return Number(spec);
}

export function routeDefinitionsToHTTPRoutes(
  routes: RouteDefinition[],
): HTTPRouteDefinition[] {
  return routes.map((r) => ({
    endpoint: r.endpoint,
    method: r.method,
    operationId: r.operationId,
    policy: r.policy,
    pathParams: r.pathParams,
    summary: r.summary,
    description: r.description,
    tags: r.tags,
    queryParams: r.queryParams,
    requestBody: r.requestBody,
    responseBody: r.responseBody,
    responseStatus:
      typeof r.responseStatus === "string" ? r.responseStatus : undefined,
    additionalResponses: r.additionalResponses,
    logging: r.logging,
    handler: async ({ req, url, params, authContext }) => {
      try {
        if (r.requireGuardian) {
          const guardianError = await requireBoundGuardian(authContext);
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
        if (
          r.method === "POST" ||
          r.method === "PUT" ||
          r.method === "PATCH" ||
          r.method === "DELETE"
        ) {
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

        // Strip any caller-supplied identity headers before deriving them
        // from the verified AuthContext. On the HTTP path the actor identity
        // always comes from the validated JWT — never from inbound headers —
        // so a request that carries these headers is either confused or
        // hostile. Without this, a caller whose token carries no
        // actorPrincipalId (svc_gateway / svc_daemon / local principals) could
        // spoof another principal — e.g. the guardian — by setting the header
        // explicitly, because the override below only fires when the context
        // supplies a value. Handlers that gate on principal identity (surface
        // action `apr:*` guardian decisions, guardian actions, host proxies)
        // would then apply a decision as the impersonated principal. Mirrors
        // the gateway IPC proxy (gateway/src/http/routes/ipc-runtime-proxy.ts).
        delete headers["x-vellum-actor-principal-id"];
        delete headers["x-vellum-principal-type"];

        // Inject auth context fields so transport-agnostic handlers can
        // resolve trust context without importing auth internals.
        if (authContext?.actorPrincipalId) {
          headers["x-vellum-actor-principal-id"] = authContext.actorPrincipalId;
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

        const headerArgs: ResponseHeaderArgs = {
          pathParams,
          queryParams,
          headers,
        };

        const responseHeaders = resolveResponseHeaders(
          r.responseHeaders,
          headerArgs,
        );

        const status = resolveResponseStatus(r.responseStatus, headerArgs);

        // 204 No Content — discard handler result, return empty body
        if (status === 204) {
          return new Response(null, { status: 204, headers: responseHeaders });
        }

        // RouteResponse — handler-supplied body + headers (e.g. binary
        // content with dynamic Content-Type / Content-Range).
        if (result instanceof RouteResponse) {
          return new Response(result.body, {
            status: result.status ?? status,
            headers: { ...responseHeaders, ...result.headers },
          });
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
            err.details,
          );
        }
        throw err;
      }
    },
  }));
}
