/**
 * Adapts transport-agnostic RouteDefinitions into IpcRoutes for the
 * AssistantIpcServer.
 *
 * IPC callers currently send a flat params object. The adapter treats it
 * as both pathParams and body for backward compatibility. As CLI callers
 * are updated to send structured `{ pathParams, queryParams, body }`
 * payloads, the flat fallback can be removed.
 */

import type { RouteDefinition } from "../../runtime/routes/types.js";
import type { IpcRoute } from "../assistant-server.js";

export function routeDefinitionsToIpcRoutes(
  routes: RouteDefinition[],
): IpcRoute[] {
  // Routes that require guardian binding are excluded from IPC — they will
  // migrate to the gateway which owns guardian identity long-term.
  return routes
    .filter((r) => !r.requireGuardian)
    .map((r) => ({
      method: r.operationId,
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
    }));
}
