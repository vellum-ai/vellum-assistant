/**
 * Adapts transport-agnostic RouteDefinitions into IpcRoutes for the
 * AssistantIpcServer.
 *
 * Currently passes the IPC params bag as both pathParams and body since
 * existing CLI consumers send a flat params object. As routes are cut over
 * to IPC, their CLI callers will likely need updating to send structured
 * `{ pathParams, queryParams, body }` payloads instead.
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
        pathParams: params as Record<string, string>,
        body: params,
      }),
  }));
}
