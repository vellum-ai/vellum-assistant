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
  return routes.map((r) => ({
    method: r.operationId,
    handler: (params?: Record<string, unknown>) =>
      r.handler({
        pathParams: (params as Record<string, string> | undefined) ?? {},
        body: params,
      }),
  }));
}
