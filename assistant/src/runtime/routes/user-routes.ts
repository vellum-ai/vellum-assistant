/**
 * Route definitions for user-defined endpoints under `/x/*`.
 *
 * Registers a single catch-all route that delegates to the
 * UserRouteDispatcher for file-based dispatch from
 * `$VELLUM_WORKSPACE_DIR/routes/`.
 */

import type { RouteDefinition } from "../http-router.js";
import { UserRouteDispatcher } from "./user-route-dispatcher.js";

const dispatcher = new UserRouteDispatcher();

/**
 * HTTP methods supported by user-defined route handlers.
 *
 * Each method gets its own route definition so the HttpRouter can match
 * on method before dispatching. The catch-all `x/:path*` pattern ensures
 * all sub-paths are captured regardless of depth.
 */
const METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export function userRouteDefinitions(): RouteDefinition[] {
  return METHODS.map((method) => ({
    endpoint: "x/:path*",
    method,
    policyKey: "x",
    summary: `User-defined ${method} route`,
    description: `Dispatches ${method} requests to user-defined handler files in the workspace routes directory.`,
    tags: ["user-routes"],
    handler: ({ params, req }) => dispatcher.dispatch(params.path, req),
  }));
}
