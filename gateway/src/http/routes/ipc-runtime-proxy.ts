/**
 * IPC runtime proxy — serves HTTP requests by calling the assistant daemon
 * over IPC instead of forwarding them as HTTP.
 *
 * Activated when the client sends the `X-Vellum-Proxy-Server: ipc` header
 * AND the request path matches a route in the schema cache. This is the
 * testing gate for the IPC cutover; once proven, the header check is removed
 * and IPC becomes the default transport.
 *
 * The proxy translates the HTTP request into the structured RouteHandlerArgs
 * shape that transport-agnostic route handlers expect, calls the daemon via
 * IPC, and converts the result back into an HTTP Response.
 */

import { validateEdgeToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import {
  ipcCallAssistantStrict,
  IpcHandlerError,
  IpcTransportError,
} from "../../ipc/assistant-client.js";
import { matchRoute } from "../../ipc/route-schema-cache.js";
import { getLogger } from "../../logger.js";

const log = getLogger("ipc-runtime-proxy");

const V1_PREFIX = "/v1/";
const VELLUM_HEADER_PREFIX = "x-vellum-";

/**
 * Attempt to serve a request via IPC.
 *
 * Returns `null` when the request doesn't have the
 * `X-Vellum-Proxy-Server: ipc` header — the caller should fall through
 * to the HTTP proxy.
 *
 * Once the header is present, the proxy commits to serving the request
 * over IPC: path mismatches return 404 and errors return proper status
 * codes rather than falling through.
 */
export async function tryIpcProxy(
  req: Request,
  config: GatewayConfig,
): Promise<Response | null> {
  if (req.headers.get("x-vellum-proxy-server") !== "ipc") {
    return null;
  }

  // --- Auth: replicate the gateway's JWT validation -----------------------
  if (config.runtimeProxyRequireAuth && req.method !== "OPTIONS") {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const edgeJwt = authHeader.slice(7);
    const result = validateEdgeToken(edgeJwt);
    if (!result.ok) {
      log.warn(
        {
          method: req.method,
          path: new URL(req.url).pathname,
          reason: result.reason,
        },
        "IPC proxy auth rejected",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // --- Route matching -----------------------------------------------------
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (!pathname.startsWith(V1_PREFIX)) {
    return Response.json(
      { error: "Not found", source: "ipc-proxy" },
      { status: 404 },
    );
  }

  const routePath = pathname.slice(V1_PREFIX.length);
  const match = matchRoute(req.method, routePath);
  if (!match) {
    return Response.json(
      { error: "Not found", source: "ipc-proxy" },
      { status: 404 },
    );
  }

  const start = performance.now();

  // --- Build structured IPC params ----------------------------------------
  const queryParams: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryParams[key] = value;
  }

  // Only forward X-Vellum-* headers to the daemon.
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.startsWith(VELLUM_HEADER_PREFIX)) {
      headers[key] = value;
    }
  });

  let body: Record<string, unknown> | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") || contentType === "") {
      try {
        const parsed = (await req.json()) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          body = parsed;
        }
      } catch {
        // No body or invalid JSON — handler will validate
      }
    }
  }

  const params: Record<string, unknown> = {
    pathParams: match.pathParams,
    queryParams,
    body,
    headers,
  };

  // --- Call daemon via IPC ------------------------------------------------
  try {
    const result = await ipcCallAssistantStrict(match.operationId, params);

    const duration = Math.round(performance.now() - start);
    log.info(
      {
        method: req.method,
        path: pathname,
        operationId: match.operationId,
        duration,
      },
      "IPC proxy request completed",
    );

    if (result === undefined || result === null) {
      return Response.json(null, { status: 200 });
    }

    if (typeof result === "string") {
      return new Response(result);
    }

    return Response.json(result);
  } catch (err) {
    const duration = Math.round(performance.now() - start);

    if (err instanceof IpcHandlerError) {
      log.warn(
        {
          method: req.method,
          path: pathname,
          operationId: match.operationId,
          statusCode: err.statusCode,
          errorCode: err.code,
          duration,
        },
        "IPC proxy handler error",
      );
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }

    if (err instanceof IpcTransportError) {
      log.error(
        {
          err,
          method: req.method,
          path: pathname,
          operationId: match.operationId,
          duration,
        },
        "IPC proxy transport error",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    log.error(
      {
        err,
        method: req.method,
        path: pathname,
        operationId: match.operationId,
        duration,
      },
      "IPC proxy unexpected error",
    );
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
