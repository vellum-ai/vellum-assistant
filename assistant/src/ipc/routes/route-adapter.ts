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
import { isRouteResponse } from "../../runtime/routes/types.js";
import type { IpcRoute } from "../assistant-server.js";

export function routeDefinitionsToIpcRoutes(
  routes: RouteDefinition[],
): IpcRoute[] {
  return routes.map((r) => ({
    method: r.operationId,
    handler: async (params?: Record<string, unknown>) => {
      const result = await r.handler({
        pathParams: (params as Record<string, string> | undefined) ?? {},
        body: params,
      });

      // RouteResponse values carry binary/string bodies with headers.
      // Over IPC, we return the result as-is and let the IPC server
      // handle framing. JSON results pass through unchanged.
      // TODO: when IPC server sends binary frames, extract body/headers
      // from RouteResponse here and return them separately.
      if (isRouteResponse(result)) {
        return result;
      }
      return result;
    },
  }));
}
