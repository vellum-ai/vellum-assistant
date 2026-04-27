/**
 * Adapts transport-agnostic RouteDefinitions into IpcRoutes for the
 * AssistantIpcServer.
 */

import type { RouteDefinition } from "../../runtime/routes/types.js";
import type { IpcRoute } from "../assistant-server.js";

export function routeDefinitionsToIpcRoutes(
  routes: RouteDefinition[],
): IpcRoute[] {
  return routes.map((r) => ({
    method: r.operationId,
    handler: (params?: Record<string, unknown>) =>
      r.handler({ params, body: params }),
  }));
}
