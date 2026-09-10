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

import { PLUGIN_NOTICES_ROUTE_PREFIX } from "@vellumai/gateway-client";

import { ACTOR_PRINCIPALS, GATEWAY_PRINCIPALS } from "../auth/route-policy.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { IDENTITY_HEADERS, RouteResponse } from "./types.js";
import { UserRouteDispatcher } from "./user-route-dispatcher.js";
import {
  isPluginNoticeRoutePath,
  PLUGIN_ROUTE_SEGMENT,
} from "./user-route-resolution.js";

const dispatcher = new UserRouteDispatcher();

/**
 * The identity a user-authored handler is allowed to see. The verified
 * subject is withheld: it is the daemon's own authorization material (an
 * OAuth proxy grant is honored for the subject it names), and handler files
 * in the workspace are a wider audience than the routes that gate on it.
 * Every other {@link IDENTITY_HEADERS} entry is withheld too, so a new one
 * reaches user code only when someone adds it here.
 */
const USER_HANDLER_IDENTITY_HEADERS = new Set<string>([
  "x-vellum-principal-type",
  "x-vellum-actor-principal-id",
]);

/**
 * Origin every user-authored handler sees, whatever transport carried the
 * request. Handler files that resolve a relative URL against `request.url`, or
 * echo it back, therefore read the same host on every transport and on every
 * install, and no handler learns the daemon's listening address.
 */
const USER_HANDLER_ORIGIN = "http://localhost";

/**
 * URL for a request that did not arrive over HTTP, rebuilt from the matched
 * path and the flattened query. Repeated query keys collapsed on the way in,
 * so only `rawUrl` carries them.
 */
function reconstructUrl(args: RouteHandlerArgs): URL {
  const path = args.pathParams?.path ?? "";
  const url = new URL(`${USER_HANDLER_ORIGIN}/v1/x/${path}`);
  for (const [k, v] of Object.entries(args.queryParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url;
}

/**
 * URL the handler is given: the wire pathname and query when the request
 * arrived over HTTP, so percent-encoding and repeated query keys survive,
 * always under {@link USER_HANDLER_ORIGIN}.
 *
 * An IPC caller controls every handler arg, so the guard checks the type
 * rather than truthiness. A `URL` pathname always carries a single leading
 * slash; a plain object could carry two, and `//host/x` resolves against any
 * base to `http://host/x`, which is the one thing this origin exists to
 * prevent.
 */
function handlerUrl(args: RouteHandlerArgs): URL {
  const rawUrl = args.rawUrl;
  if (!(rawUrl instanceof URL)) {
    return reconstructUrl(args);
  }
  return new URL(`${rawUrl.pathname}${rawUrl.search}`, USER_HANDLER_ORIGIN);
}

/**
 * Reconstruct a Web API `Request` from transport-agnostic handler args.
 *
 * The synthesized Request carries all information the dispatcher needs:
 * path, method, headers, and body. Its origin is synthetic on every transport,
 * so user handlers should not depend on host, port, or scheme.
 */
function synthesizeRequest(method: string, args: RouteHandlerArgs): Request {
  const url = handlerUrl(args);

  const headers = new Headers(args.headers ?? {});
  for (const name of IDENTITY_HEADERS) {
    if (!USER_HANDLER_IDENTITY_HEADERS.has(name)) {
      headers.delete(name);
    }
  }

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

/**
 * Serve one request from the handler file at `/x/<routePath>`.
 *
 * The matched path is written back as the single `path` param before the
 * request is synthesized, so a handler sees the same URL whichever route
 * definition matched and whichever transport carried the request (the IPC
 * path rebuilds the URL from that param; see {@link reconstructUrl}).
 */
async function serveUserRoute(
  method: string,
  args: RouteHandlerArgs,
  routePath: string,
): Promise<RouteResponse> {
  const request = synthesizeRequest(method, {
    ...args,
    pathParams: { path: routePath },
  });
  const response = await dispatcher.dispatch(routePath, request);
  return decomposeResponse(response);
}

/**
 * A plugin's `notices/` routes, served to the gateway alone.
 *
 * The gateway posts a notice there when it has decided something on the
 * plugin's behalf and the plugin has to act on it with its own vendor
 * credentials, without running a turn (`PLUGIN_ADMISSION_DENIED_NOTICE_PATH`
 * is the first). An actor client reaching the same path would hand the plugin
 * a forged decision, so the whole prefix takes the gateway's service
 * principal only, for every method.
 *
 * Listed ahead of the catch-all below: the HTTP router and the gateway's IPC
 * proxy both take the first definition whose pattern matches, so this policy
 * only holds while these come first. Two patterns, because a catch-all param
 * needs at least one character and the namespace root (`routes/notices.ts`,
 * `routes/notices/index.ts`) is a handler too.
 *
 * These patterns match the request as spelled, and only the plain spelling.
 * A percent-encoded, doubled-slash, `.`-segment or case-folded spelling of
 * the same path reaches the catch-all instead, which is why the catch-all
 * refuses the namespace outright (see {@link isPluginNoticeRoutePath}).
 */
const PLUGIN_NOTICE_ROUTES: RouteDefinition[] = METHODS.flatMap((method) => {
  const policy: RouteDefinition["policy"] = {
    requiredScopes: ["internal.write"],
    allowedPrincipalTypes: GATEWAY_PRINCIPALS,
  };
  const namespace = `x/${PLUGIN_ROUTE_SEGMENT}/:plugin/${PLUGIN_NOTICES_ROUTE_PREFIX}`;
  const routePath = (args: RouteHandlerArgs, rest?: string) =>
    [
      PLUGIN_ROUTE_SEGMENT,
      args.pathParams?.plugin ?? "",
      PLUGIN_NOTICES_ROUTE_PREFIX,
      ...(rest === undefined ? [] : [rest]),
    ].join("/");
  return [
    {
      operationId: `plugin_notice_root_${method.toLowerCase()}`,
      endpoint: namespace,
      method,
      summary: `Gateway ${method} notice to a plugin (namespace root)`,
      description: `Dispatches ${method} requests to the root handler of a plugin's reserved ${PLUGIN_NOTICES_ROUTE_PREFIX}/ namespace. Served to the gateway's service principal only: a notice is the gateway's own decision, never a client's.`,
      tags: ["user-routes"],
      policy,
      handler: (args: RouteHandlerArgs) =>
        serveUserRoute(method, args, routePath(args)),
    },
    {
      operationId: `plugin_notice_route_${method.toLowerCase()}`,
      endpoint: `${namespace}/:path*`,
      method,
      summary: `Gateway ${method} notice to a plugin`,
      description: `Dispatches ${method} requests under a plugin's reserved ${PLUGIN_NOTICES_ROUTE_PREFIX}/ namespace to that plugin's handler files. Served to the gateway's service principal only: a notice is the gateway's own decision, never a client's.`,
      tags: ["user-routes"],
      policy,
      handler: (args: RouteHandlerArgs) =>
        serveUserRoute(method, args, routePath(args, args.pathParams?.path)),
    },
  ];
});

const USER_ROUTES: RouteDefinition[] = METHODS.map((method) => ({
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
  handler: (args: RouteHandlerArgs) => {
    const routePath = args.pathParams?.path ?? "";
    if (isPluginNoticeRoutePath(routePath)) {
      // Another spelling of a reserved path. The notice definitions above are
      // the only ones that serve the namespace, and they saw a request that
      // did not match them, so this is refused rather than dispatched under
      // the actor policy. Same answer the policy check gives the plain
      // spelling, so a prober learns nothing from the respelling.
      return decomposeResponse(
        httpError(
          "FORBIDDEN",
          "Principal type not permitted for this endpoint",
          403,
        ),
      );
    }
    return serveUserRoute(method, args, routePath);
  },
}));

export const ROUTES: RouteDefinition[] = [
  ...PLUGIN_NOTICE_ROUTES,
  ...USER_ROUTES,
];
