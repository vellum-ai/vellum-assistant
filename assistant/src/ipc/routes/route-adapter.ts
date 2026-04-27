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
import type { IpcRoute } from "../assistant-server.js";

export function routeDefinitionsToIpcRoutes(
  routes: RouteDefinition[],
): IpcRoute[] {
  return routes
    .filter((r) => !r.requireGuardian)
    .map((r) => ({
      method: r.operationId,

      // Legacy flat-params handler for CLI callers
      handler: (params?: Record<string, unknown>) => {
        const stringParams: Record<string, string> = {};
        if (params) {
          for (const [k, v] of Object.entries(params)) {
            if (typeof v === "string") stringParams[k] = v;
          }
        }
        return r.handler({
          pathParams: stringParams,
          queryParams: stringParams,
          body: params,
        });
      },

      // Structured handler — direct pass-through to the route handler
      structuredHandler: r.handler,
    }));
}
