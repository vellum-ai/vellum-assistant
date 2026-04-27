/**
 * Adapts transport-agnostic RouteDefinitions into IpcRoutes for the
 * AssistantIpcServer.
 *
 * IPC callers can send either:
 *   - Structured: `{ pathParams, queryParams, body }` → passed through as-is
 *   - Flat: `{ key: value, ... }` → treated as both pathParams and body
 *     for backward compatibility with existing CLI consumers
 *
 * As CLI callers are updated to send structured payloads, the flat
 * fallback can be removed.
 */

import type {
  RouteDefinition,
  RouteHandlerArgs,
} from "../../runtime/routes/types.js";
import type { IpcRoute } from "../assistant-server.js";

function isStructuredArgs(params: Record<string, unknown>): boolean {
  return (
    "pathParams" in params || "queryParams" in params || "body" in params
  );
}

export function routeDefinitionsToIpcRoutes(
  routes: RouteDefinition[],
): IpcRoute[] {
  return routes.map((r) => ({
    method: r.operationId,
    handler: (params?: Record<string, unknown>) => {
      if (params && isStructuredArgs(params)) {
        return r.handler(params as unknown as RouteHandlerArgs);
      }
      return r.handler({
        pathParams: (params as Record<string, string> | undefined) ?? {},
        body: params,
      });
    },
  }));
}
