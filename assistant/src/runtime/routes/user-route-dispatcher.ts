/**
 * File-based route dispatcher for user-defined HTTP endpoints.
 *
 * Maps requests under the `/x/*` path prefix to handler modules resolved from
 * the filesystem at request time. Two locations back the surface:
 *
 * - `$VELLUM_WORKSPACE_DIR/routes/<path>` — workspace routes, served at
 *   `/x/<path>`.
 * - `$VELLUM_WORKSPACE_DIR/plugins/<name>/routes/<path>` — a plugin's routes,
 *   served in that plugin's namespace at `/x/plugins/<name>/<path>`. The
 *   `plugins/<name>/` prefix is reserved for this: a request there resolves
 *   only against the named plugin's `routes/` directory (never the workspace
 *   `routes/plugins/…` tree) so plugins can't collide with workspace routes or
 *   each other.
 *
 * Each handler file exports named functions for HTTP methods (GET, POST, PUT,
 * etc.) using the standard Web API Request/Response signature. New handlers
 * reach daemon capabilities by importing `@vellumai/plugin-api` (e.g.
 * `publishEvent`, `runConversationTurn`), which broker process-safe access — so
 * a handler behaves identically in-process and in the route-host subprocess.
 *
 * The dispatcher resolves the handler file, then hands execution to the route
 * host subprocess ({@link RouteHostClient}): the handler runs off the daemon's
 * event loop, so one that blocks synchronously pins only the host process and
 * is reclaimed with a hard kill. A request whose file does not exist 404s
 * before the host is touched — nothing is registered ahead of time. Handlers
 * that need to reach daemon state import the relevant `@vellumai/plugin-api`
 * helpers (e.g. `publishEvent`, `runConversationTurn`).
 */

import { statSync } from "node:fs";

import {
  RouteHostClient,
  RouteHostTimeoutError,
  RouteHostUnavailableError,
} from "../../routes/route-host-client.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import {
  resolveHandlerFile,
  resolveRouteLocation,
} from "./user-route-resolution.js";

const log = getLogger("user-routes");

/** Default per-request timeout for user-defined route handlers (2 minutes). */
const DEFAULT_HANDLER_TIMEOUT_MS = 120_000;

export class UserRouteDispatcher {
  private readonly handlerTimeoutMs: number;
  /**
   * The route host client. Constructing it is inert — the subprocess spawns
   * lazily on the client's first `invoke` — so a dispatcher that never serves a
   * request never spawns one.
   */
  private readonly routeHostClient: RouteHostClient;

  constructor(options?: { handlerTimeoutMs?: number }) {
    this.handlerTimeoutMs =
      options?.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    // The host client's hard-kill deadline is the dispatcher's per-request
    // timeout, not the client's own default.
    this.routeHostClient = new RouteHostClient({
      invokeTimeoutMs: this.handlerTimeoutMs,
    });
  }

  /**
   * Dispatch a request to the appropriate user-defined handler file.
   *
   * @param routePath The path after the `x/` prefix (e.g. `my-app/status`).
   * @param request   The original HTTP request.
   * @returns A Response from the handler, or an error response (404, 405, 500).
   */
  async dispatch(routePath: string, request: Request): Promise<Response> {
    if (routePath.includes("..")) {
      return httpError("BAD_REQUEST", "Path traversal is not allowed", 400);
    }

    const location = resolveRouteLocation(routePath);
    const filePath = location
      ? resolveHandlerFile(location.routesDir, location.subPath)
      : null;

    if (!filePath) {
      return httpError(
        "NOT_FOUND",
        `No route handler found for /x/${routePath}`,
        404,
      );
    }

    return this.dispatchViaHost(filePath, routePath, request);
  }

  /**
   * Delegate execution to the route host subprocess. The main thread has
   * already resolved `filePath` (and 404'd if missing); here it marshals the
   * request, hands it to the host, and rebuilds a `Response` from the reply.
   * Maps the host's typed failures to HTTP: timeout → 504, host unavailable →
   * 503, and a handler that threw → 500.
   */
  private async dispatchViaHost(
    filePath: string,
    routePath: string,
    request: Request,
  ): Promise<Response> {
    const mtimeMs = statSync(filePath).mtimeMs;

    const headers: [string, string][] = [];
    request.headers.forEach((value, name) => {
      headers.push([name, value]);
    });
    let body: Uint8Array | null = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const buffer = new Uint8Array(await request.arrayBuffer());
      body = buffer.byteLength > 0 ? buffer : null;
    }

    try {
      const result = await this.routeHostClient.invoke(
        {
          filePath,
          mtimeMs,
          method: request.method,
          url: request.url,
          headers,
        },
        body,
      );
      const responseHeaders = new Headers();
      for (const [name, value] of result.headers) {
        responseHeaders.append(name, value);
      }
      // `Uint8Array` is a valid body at runtime; the cast placates the DOM lib's
      // `Uint8Array<ArrayBuffer>` vs `ArrayBufferLike` generic mismatch.
      return new Response(result.body as BodyInit | null, {
        status: result.status,
        headers: responseHeaders,
      });
    } catch (err) {
      if (err instanceof RouteHostTimeoutError) {
        return httpError(
          "SERVICE_UNAVAILABLE",
          `Route handler for /x/${routePath} timed out after ${err.timeoutMs}ms`,
          504,
        );
      }
      if (err instanceof RouteHostUnavailableError) {
        return httpError(
          "SERVICE_UNAVAILABLE",
          `Route host is unavailable; retry shortly`,
          503,
        );
      }
      log.error({ err, routePath }, "User route handler threw an error");
      const message =
        err instanceof Error ? err.message : "Internal server error";
      return httpError("INTERNAL_ERROR", message, 500);
    }
  }
}
