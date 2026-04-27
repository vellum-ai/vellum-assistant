/**
 * IPC route that exposes the daemon's route schema to the gateway.
 *
 * The gateway calls `get_route_schema` on startup (and on reconnect) to
 * discover which routes the daemon serves, enabling it to proxy HTTP
 * requests over IPC instead of forwarding them as HTTP.
 *
 * The response is a flat array of route descriptors — endpoint pattern,
 * HTTP method, and operationId — which is everything the gateway needs to
 * match an inbound HTTP request to an IPC method call.
 */

import { ROUTES } from "../../runtime/routes/index.js";
import type { IpcRoute } from "../assistant-server.js";

export interface RouteSchemaEntry {
  operationId: string;
  endpoint: string;
  method: string;
}

function getRouteSchema(): RouteSchemaEntry[] {
  return ROUTES.map((r) => ({
    operationId: r.operationId,
    endpoint: r.endpoint,
    method: r.method,
  }));
}

export const routeSchemaRoute: IpcRoute = {
  method: "get_route_schema",
  handler: getRouteSchema,
};
