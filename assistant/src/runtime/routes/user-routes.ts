/**
 * Route definitions for user-defined endpoints under `/x/*`.
 *
 * Registers one route per HTTP method that delegates to the
 * UserRouteDispatcher for file-based dispatch. The dispatcher resolves each
 * request against the filesystem at request time: workspace routes from
 * `$VELLUM_WORKSPACE_DIR/routes/`, and a plugin's routes from
 * `$VELLUM_WORKSPACE_DIR/plugins/<name>/routes/` under the reserved
 * `/x/plugins/<name>/` namespace.
 *
 * The dispatcher operates on native `Request`/`Response` objects (the
 * contract with user-authored handler files). This module bridges the
 * transport-agnostic `RouteHandlerArgs` → `Request` on the way in and
 * `Response` → handler return value on the way out, so user routes work
 * over both HTTP and IPC.
 */

import { postRouteConversationMessage } from "../../daemon/route-conversation-post.js";
import { getLogger } from "../../util/logger.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { RouteResponse } from "./types.js";
import type { UserRouteContext } from "./user-route-dispatcher.js";
import { UserRouteDispatcher } from "./user-route-dispatcher.js";
import { UserRouteWorkerPool } from "./user-route-worker-pool.js";

const log = getLogger("user-routes");

const context: UserRouteContext = {
  assistantEventHub,
  conversations: {
    postMessage: postRouteConversationMessage,
  },
};

/**
 * Opt-in: run user route handlers on a worker-thread pool instead of inline on
 * the daemon's event loop. Off by default while the pool is validated against
 * real handlers — set `VELLUM_USER_ROUTES_WORKER_POOL=1` to enable. When enabled,
 * a synchronously-stalling handler pins only a worker thread, not the daemon.
 */
const pool =
  process.env.VELLUM_USER_ROUTES_WORKER_POOL === "1"
    ? new UserRouteWorkerPool({ context })
    : undefined;

if (pool) {
  log.info("User routes running on worker-thread pool (opt-in)");
}

const dispatcher = new UserRouteDispatcher({ context, pool });

/**
 * Reconstruct a Web API `Request` from transport-agnostic handler args.
 *
 * The synthesized Request carries all information the dispatcher needs:
 * path, method, headers, and body. The host/port/scheme are synthetic —
 * user handlers should not depend on them.
 */
function synthesizeRequest(method: string, args: RouteHandlerArgs): Request {
  const path = args.pathParams?.path ?? "";
  const url = new URL(`http://localhost/v1/x/${path}`);
  for (const [k, v] of Object.entries(args.queryParams ?? {})) {
    url.searchParams.set(k, v);
  }

  const headers = new Headers(args.headers ?? {});

  let body: BodyInit | undefined;
  if (args.rawBody) {
    body = args.rawBody.buffer as ArrayBuffer;
  } else if (args.body) {
    body = JSON.stringify(args.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = body;
  }
  if (args.abortSignal) {
    init.signal = args.abortSignal;
  }

  return new Request(url, init);
}

/**
 * Collect response headers into a plain record.
 */
function collectHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return headers;
}

/**
 * Decompose a Web API `Response` into a `RouteResponse` that the route
 * adapters (HTTP and IPC) can handle.
 *
 * Always wraps in `RouteResponse` so that status codes, custom headers
 * (CORS, Cache-Control, etc.), and null bodies (204/304) are preserved
 * faithfully. The body stream is passed through as-is — no
 * parse/stringify round-trip.
 */
function decomposeResponse(response: Response): RouteResponse {
  const headers = collectHeaders(response);
  return new RouteResponse(response.body, headers, response.status);
}

/**
 * HTTP methods supported by user-defined route handlers.
 *
 * Each method gets its own route definition so the router can match
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

export const ROUTES: RouteDefinition[] = METHODS.map((method) => ({
  operationId: `user_route_${method.toLowerCase()}`,
  endpoint: "x/:path*",
  method,
  summary: `User-defined ${method} route`,
  description: `Dispatches ${method} requests to user-defined handler files in the workspace routes directory.`,
  tags: ["user-routes"],
  policy: {
    requiredScopes: ["settings.read"],
    allowedPrincipalTypes: ACTOR_PRINCIPALS,
  },
  handler: async (args: RouteHandlerArgs) => {
    const request = synthesizeRequest(method, args);
    const response = await dispatcher.dispatch(
      args.pathParams?.path ?? "",
      request,
    );
    return decomposeResponse(response);
  },
}));
