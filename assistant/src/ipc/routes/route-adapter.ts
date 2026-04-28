/**
 * Adapts transport-agnostic RouteDefinitions into IpcRoutes for the
 * AssistantIpcServer.
 *
 * Generates two handlers per route:
 *
 * - `handler` (legacy): receives a flat params bag, treats string values
 *   as both pathParams and queryParams, full bag as body. Used by CLI
 *   callers that haven't migrated to structured payloads yet.
 *
 * - `structuredHandler`: passes through directly to the route handler.
 *   Used by the gateway IPC proxy, which sends separated
 *   { pathParams, queryParams, body, headers }.
 *
 * The IPC server prefers structuredHandler when present, falling back
 * to handler for routes that only have the legacy path.
 */

import type { RouteDefinition } from "../../runtime/routes/types.js";
import type {
  IpcBinaryResponse,
  IpcRoute,
  IpcStreamingResponse,
} from "../assistant-server.js";

function resolveResponseHeaders(
  spec: RouteDefinition["responseHeaders"],
  pathParams: Record<string, string>,
  queryParams: Record<string, string>,
): Record<string, string> {
  if (!spec) return {};
  if (typeof spec === "function") return spec({ pathParams, queryParams });
  return spec;
}

function isIpcEligible(r: RouteDefinition): boolean {
  return !r.requireGuardian && !r.isPublic && !r.requirePolicyEnforcement;
}

export function routeDefinitionsToIpcRoutes(
  routes: RouteDefinition[],
): IpcRoute[] {
  const eligible = routes.filter(isIpcEligible);

  const converted: IpcRoute[] = eligible.map((r) => ({
      method: r.operationId,
      handler: async (params?: Record<string, unknown>) => {
        const stringParams: Record<string, string> = {};
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            if (typeof v === "string") stringParams[k] = v;
          }
        }

        const result = await r.handler({
          pathParams: stringParams,
          queryParams: stringParams,
          body: params,
        });

        // ReadableStream → chunked binary frames
        if (result instanceof ReadableStream) {
          const headers = resolveResponseHeaders(
            r.responseHeaders,
            stringParams,
            stringParams,
          );
          return {
            stream: result,
            headers,
          } satisfies IpcStreamingResponse;
        }

        // Uint8Array → single binary frame with content-length
        if (result instanceof Uint8Array) {
          const headers = resolveResponseHeaders(
            r.responseHeaders,
            stringParams,
            stringParams,
          );
          return {
            binary: result,
            headers,
          } satisfies IpcBinaryResponse;
        }

        return result;
      },

      // Structured handler — direct pass-through to the route handler
      structuredHandler: r.handler,
    }));

  // Append the meta-route that exposes the route schema to the gateway.
  // IPC-only: the gateway calls this on startup to discover which HTTP
  // requests can be proxied over IPC. Lives here (not in ROUTES) because
  // it describes the ROUTES array itself.
  converted.push({
    method: "get_route_schema",
    handler: async (_params?: Record<string, unknown>) =>
      eligible.map((r) => ({
        operationId: r.operationId,
        endpoint: r.endpoint,
        method: r.method,
      })),
  });

  return converted;
}
