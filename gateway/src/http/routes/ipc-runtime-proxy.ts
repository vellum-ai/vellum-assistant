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

import { getLogger } from "../../logger.js";
import { ipcCallAssistant } from "../../ipc/assistant-client.js";
import { matchRoute } from "../../ipc/route-schema-cache.js";

const log = getLogger("ipc-runtime-proxy");

const V1_PREFIX = "/v1/";

/**
 * Attempt to serve a request via IPC.
 *
 * Returns `null` when:
 * - The request doesn't have the `X-Vellum-Proxy-Server: ipc` header
 * - The path doesn't match any cached route schema entry
 * - The IPC call fails (caller should fall through to HTTP proxy)
 */
export async function tryIpcProxy(req: Request): Promise<Response | null> {
  if (req.headers.get("x-vellum-proxy-server") !== "ipc") {
    return null;
  }

  const url = new URL(req.url);
  const pathname = url.pathname;

  if (!pathname.startsWith(V1_PREFIX)) {
    return null;
  }

  const routePath = pathname.slice(V1_PREFIX.length);
  const match = matchRoute(req.method, routePath);
  if (!match) {
    return null;
  }

  const start = performance.now();

  const queryParams: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    queryParams[key] = value;
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
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
    // TODO: binary body support (rawBody) for non-JSON content types
  }

  const params: Record<string, unknown> = {
    pathParams: match.pathParams,
    queryParams,
    body,
    headers,
  };

  try {
    const result = await ipcCallAssistant(match.operationId, params);

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

    if (result instanceof Uint8Array) {
      return new Response(result as unknown as BodyInit);
    }

    if (result instanceof ArrayBuffer) {
      return new Response(result);
    }

    return Response.json(result);
  } catch (err) {
    const duration = Math.round(performance.now() - start);
    log.error(
      {
        err,
        method: req.method,
        path: pathname,
        operationId: match.operationId,
        duration,
      },
      "IPC proxy request failed",
    );
    return null;
  }
}
