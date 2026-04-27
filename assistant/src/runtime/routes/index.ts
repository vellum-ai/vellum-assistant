/**
 * Shared route definitions served by BOTH the HTTP server and the IPC server.
 *
 * Routes listed here are registered in the HTTP router (via buildRouteTable)
 * and exposed as IPC methods on the AssistantIpcServer (via cliIpcRoutes).
 *
 * Over time, routes will migrate from their HTTP-only or IPC-only homes
 * into this shared array.
 */

import { ROUTES as IDENTITY_ROUTES } from "./identity-routes.js";
import { ROUTES as PS_ROUTES } from "./ps-routes.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [...IDENTITY_ROUTES, ...PS_ROUTES];
