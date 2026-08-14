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
 * etc.) using the standard Web API Request/Response signature. Plugin handlers
 * receive a bounded route context from `@vellumai/plugin-api`. Its host facade
 * exposes only operations approved for both execution modes.
 *
 * For backward compatibility, the in-process path still passes a **deprecated**
 * `context` second argument (see `deprecated-route-context.ts`): a thin shim
 * over those same plugin-api calls that records a deprecation-usage telemetry
 * signal so remaining callers can be found and migrated. The route-host path
 * does not supply it. The argument is transitional and removed once telemetry
 * shows no route depends on it.
 *
 * Modules are lazily loaded on first request and cached by file path +
 * mtime. When a file changes on disk, the next request evicts the whole
 * source tree that file belongs to (plugin root, or the workspace
 * `routes/` directory) and re-imports the entry. Cache-busting only the
 * entry file would re-bind it to stale helpers still in Bun's registry.
 * A request whose file does not exist 404s. Nothing is registered ahead
 * of time.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

import {
  type PluginRouteActorContext,
  type PluginRouteContext,
  runInPluginRouteContext,
} from "../../plugin-api/route-context.js";
import type { VerifiedPeerOperationContext } from "../../plugin-api/verified-peer-context.js";
import { runInPluginContext } from "../../plugins/plugin-execution-context.js";
import { getPluginReadiness } from "../../plugins/plugin-readiness.js";
import {
  findPluginRouteDeclaration,
  type PluginRouteAuthorization,
  type PluginRouteManifestResult,
} from "../../plugins/plugin-route-manifest.js";
import { resolvePluginStorageDir } from "../../plugins/plugin-storage.js";
import { isRouteHostEnabled } from "../../routes/control.js";
import type { RouteHostBrokerContext } from "../../routes/route-host-broker.js";
import {
  RouteHostClient,
  RouteHostTimeoutError,
  RouteHostUnavailableError,
} from "../../routes/route-host-client.js";
import { getLogger } from "../../util/logger.js";
import { enforcePluginRoutePolicy } from "../auth/route-policy.js";
import { httpError } from "../http-errors.js";
import {
  buildDeprecatedRouteContext,
  type UserRouteContext,
} from "./deprecated-route-context.js";
import {
  evictRouteSourceTree,
  importRouteModule,
  routeSourceRoot,
} from "./user-route-import.js";
import {
  resolveHandlerFile,
  resolveRouteLocation,
} from "./user-route-resolution.js";

const log = getLogger("user-routes");

// ---------------------------------------------------------------------------
// Route handler types
// ---------------------------------------------------------------------------

/** HTTP methods that can be exported from a handler module. */
const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * The function signature that user-defined route handlers must follow. New
 * handlers take just the `Request` and reach daemon state through
 * `@vellumai/plugin-api`. A deprecated `context` second argument is still passed
 * on the in-process path for backward compatibility (see
 * `deprecated-route-context.ts`); handlers that omit the parameter ignore it.
 */
type RouteHandler = (
  request: Request,
  context: UserRouteContext,
) => Response | Promise<Response>;

/** A loaded handler module with its cached metadata. */
interface CachedModule {
  /** The module's exports (keyed by HTTP method name). */
  handlers: Partial<Record<HttpMethod, RouteHandler>>;
  /** Optional description exported by the module for display in CLI. */
  description?: string;
  /** The file's mtime at the time of loading, in milliseconds. */
  mtimeMs: number;
}

interface PluginRouteExecution {
  readonly context: PluginRouteContext;
  readonly brokerContext: RouteHostBrokerContext;
}

export interface UserRouteDispatchContext {
  readonly actor: PluginRouteActorContext;
  readonly requestId?: string;
  readonly verifiedPeer?: VerifiedPeerOperationContext | null;
  readonly signal?: AbortSignal;
}

/** Default per-request timeout for user-defined route handlers (2 minutes). */
const DEFAULT_HANDLER_TIMEOUT_MS = 120_000;

export class UserRouteDispatcher {
  private moduleCache = new Map<string, CachedModule>();
  private handlerTimeoutMs: number;
  /**
   * The route host client. Constructing it is inert — the subprocess spawns
   * lazily on the client's first `invoke` — so a dispatcher whose host is never
   * enabled never spawns one.
   */
  private readonly routeHostClient: RouteHostClient;

  constructor(options: { handlerTimeoutMs?: number } = {}) {
    this.handlerTimeoutMs =
      options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    // Both execution paths — in-process ({@link executeHandler}) and the route
    // host subprocess — must honor the same per-request timeout, so the host
    // client's hard-kill deadline is driven by the dispatcher's timeout rather
    // than its own independent default.
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
  async dispatch(
    routePath: string,
    request: Request,
    dispatchContext?: UserRouteDispatchContext,
  ): Promise<Response> {
    if (routePath.includes("..")) {
      return httpError("BAD_REQUEST", "Path traversal is not allowed", 400);
    }

    const location = resolveRouteLocation(routePath);
    if (!location) {
      return httpError(
        "NOT_FOUND",
        `No route handler found for /x/${routePath}`,
        404,
      );
    }

    if (
      !location.pluginId &&
      dispatchContext?.actor.principalType === "assistant_peer"
    ) {
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Assistant peers cannot call workspace routes",
          },
        },
        { status: 403 },
      );
    }

    if (
      !location.pluginId &&
      dispatchContext &&
      !dispatchContext.actor.scopes.includes("settings.read") &&
      !dispatchContext.actor.scopes.includes("local.all")
    ) {
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Missing required scope: settings.read",
          },
        },
        { status: 403 },
      );
    }

    if (location.pluginId) {
      const isInstalledPlugin = location.pluginDir !== undefined;
      const unavailable = this.pluginUnavailableResponse(
        location.pluginId,
        location.routeManifest,
        isInstalledPlugin,
      );
      if (unavailable) {
        return unavailable;
      }

      const authorization = this.resolveAuthorization(
        location.pluginId,
        location.subPath,
        request.method,
        location.routeManifest,
      );
      if (authorization instanceof Response) {
        return authorization;
      }

      const denied = enforcePluginRoutePolicy(
        `/x/${routePath}`,
        location.pluginId,
        authorization,
        this.resolvePluginRouteActor(dispatchContext),
        dispatchContext?.verifiedPeer ?? null,
      );
      if (denied) {
        return denied;
      }
    }

    const filePath = resolveHandlerFile(location.routesDir, location.subPath);
    if (!filePath) {
      return httpError(
        "NOT_FOUND",
        `No route handler found for /x/${routePath}`,
        404,
      );
    }

    const pluginRoute = location.pluginId
      ? this.buildPluginRouteContext(
          location.pluginId,
          location.pluginDir,
          request,
          dispatchContext,
        )
      : undefined;

    if (isRouteHostEnabled()) {
      return this.dispatchViaHost(filePath, routePath, request, pluginRoute);
    }

    const mod = await this.loadModule(filePath, location.routesDir);
    const method = request.method as HttpMethod;
    const handler = mod.handlers[method];

    if (!handler) {
      const allowed = HTTP_METHODS.filter((m) => m in mod.handlers);
      return new Response(null, {
        status: 405,
        headers: { Allow: allowed.join(", ") },
      });
    }

    return this.executeHandler(
      handler,
      request,
      routePath,
      pluginRoute?.context,
    );
  }

  private buildPluginRouteContext(
    pluginId: string,
    pluginDir: string | undefined,
    request: Request,
    dispatchContext: UserRouteDispatchContext | undefined,
  ): PluginRouteExecution {
    const actor = this.resolvePluginRouteActor(dispatchContext);
    const pluginStorageDir = resolvePluginStorageDir(
      pluginId,
      pluginDir ?? null,
    );
    const context: PluginRouteContext = {
      pluginId,
      actor,
      requestId: dispatchContext?.requestId ?? randomUUID(),
      signal: dispatchContext?.signal ?? request.signal,
      verifiedPeer: dispatchContext?.verifiedPeer ?? null,
      host: {
        async getPluginStorageDir(): Promise<string> {
          return pluginStorageDir;
        },
      },
    };
    return {
      context,
      brokerContext: { pluginId, pluginStorageDir },
    };
  }

  private resolvePluginRouteActor(
    dispatchContext: UserRouteDispatchContext | undefined,
  ): PluginRouteActorContext {
    return (
      dispatchContext?.actor ?? {
        principalType: "local",
        principalId: null,
        scopes: ["local.all"],
      }
    );
  }

  private pluginUnavailableResponse(
    pluginId: string,
    manifest: PluginRouteManifestResult | undefined,
    isInstalledPlugin: boolean,
  ): Response | null {
    if (manifest?.kind === "invalid") {
      return this.pluginStatusResponse(
        pluginId,
        "failed",
        "plugin_route_manifest_invalid",
        manifest.reason,
      );
    }

    if (!isInstalledPlugin) {
      return null;
    }

    const readiness = getPluginReadiness(pluginId);
    if (!readiness) {
      return this.pluginStatusResponse(
        pluginId,
        "initializing",
        "plugin_initializing",
        "Plugin is initializing",
      );
    }
    if (readiness.status === "ready") {
      return null;
    }

    const code =
      readiness.status === "incompatible"
        ? "plugin_incompatible"
        : readiness.status === "failed"
          ? "plugin_initialization_failed"
          : "plugin_initializing";
    return this.pluginStatusResponse(
      pluginId,
      readiness.status,
      code,
      readiness.message ??
        (readiness.status === "initializing"
          ? "Plugin is initializing"
          : "Plugin is unavailable"),
    );
  }

  private pluginStatusResponse(
    pluginId: string,
    status: "initializing" | "incompatible" | "failed",
    code: string,
    message: string,
  ): Response {
    return Response.json(
      {
        error: {
          code,
          message,
          details: { pluginId, status },
        },
      },
      { status: 503 },
    );
  }

  private resolveAuthorization(
    pluginId: string,
    subPath: string,
    method: string,
    manifest: PluginRouteManifestResult | undefined,
  ): PluginRouteAuthorization | Response {
    if (!manifest || manifest.kind === "legacy") {
      return { principal: "actor", requiredScopes: ["settings.read"] };
    }
    if (manifest.kind === "invalid") {
      return this.pluginStatusResponse(
        pluginId,
        "failed",
        "plugin_route_manifest_invalid",
        manifest.reason,
      );
    }

    const declaration = findPluginRouteDeclaration(
      manifest.manifest,
      subPath,
      method,
    );
    if (declaration) {
      return declaration.authorization;
    }

    const allowed = manifest.manifest.routes
      .filter((route) => route.path === subPath)
      .map((route) => route.method);
    if (allowed.length > 0) {
      return new Response(null, {
        status: 405,
        headers: { Allow: allowed.join(", ") },
      });
    }
    return httpError(
      "NOT_FOUND",
      `No route handler found for /x/plugins/${pluginId}/${subPath}`,
      404,
    );
  }

  /**
   * Delegate execution to the route host subprocess. The main thread has
   * already resolved `filePath` (and 404'd if missing); here it marshals the
   * request, hands it to the host, and rebuilds a `Response` from the reply.
   * Maps the host's typed failures to HTTP: timeout → 504, host unavailable →
   * 503, and a handler that threw → 500 (matching the in-thread contract).
   */
  private async dispatchViaHost(
    filePath: string,
    routePath: string,
    request: Request,
    pluginRoute: PluginRouteExecution | undefined,
  ): Promise<Response> {
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
          method: request.method,
          url: request.url,
          headers,
          pluginContext: pluginRoute
            ? {
                pluginId: pluginRoute.context.pluginId,
                actor: pluginRoute.context.actor,
                requestId: pluginRoute.context.requestId,
                verifiedPeer: pluginRoute.context.verifiedPeer,
              }
            : null,
        },
        {
          body,
          signal: pluginRoute?.context.signal ?? request.signal,
          brokerContext: pluginRoute?.brokerContext,
        },
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

  /**
   * Load a handler module, using the mtime-based cache when possible.
   *
   * On cache miss or stale mtime, every source file in the handler's tree
   * is evicted first so a new entry cannot import a helper that is still
   * the pre-upgrade module. Then the entry is re-imported with an mtime
   * query parameter.
   */
  private async loadModule(
    filePath: string,
    routesDir: string,
  ): Promise<CachedModule> {
    const stat = statSync(filePath);
    const mtimeMs = stat.mtimeMs;

    const cached = this.moduleCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    const sourceRoot = routeSourceRoot(routesDir);
    evictRouteSourceTree(sourceRoot);
    this.dropCachedModulesUnder(sourceRoot);

    const mod = await importRouteModule(filePath);

    const handlers: Partial<Record<HttpMethod, RouteHandler>> = {};
    for (const method of HTTP_METHODS) {
      if (typeof mod[method] === "function") {
        handlers[method] = mod[method] as RouteHandler;
      }
    }

    const description =
      typeof mod.description === "string" ? mod.description : undefined;

    const entry: CachedModule = { handlers, description, mtimeMs };
    this.moduleCache.set(filePath, entry);

    log.info(
      { filePath, methods: Object.keys(handlers), description },
      "Loaded user route handler",
    );

    return entry;
  }

  /**
   * Drop every cached handler under `sourceRoot`. Sibling routes must not
   * keep closures over the helpers we just evicted.
   */
  private dropCachedModulesUnder(sourceRoot: string): void {
    const prefix = sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`;
    for (const path of this.moduleCache.keys()) {
      if (path === sourceRoot || path.startsWith(prefix)) {
        this.moduleCache.delete(path);
      }
    }
  }

  /**
   * Execute a handler function with a per-request timeout and error boundary.
   */
  private async executeHandler(
    handler: RouteHandler,
    request: Request,
    routePath: string,
    pluginContext: PluginRouteContext | undefined,
  ): Promise<Response> {
    try {
      const invoke = () =>
        Promise.resolve(
          handler(request, buildDeprecatedRouteContext(routePath)),
        );
      const execution = pluginContext
        ? runInPluginContext(pluginContext.pluginId, () =>
            runInPluginRouteContext(pluginContext, invoke),
          )
        : invoke();
      const result = await Promise.race([
        execution,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Handler timed out")),
            this.handlerTimeoutMs,
          ),
        ),
      ]);
      return result;
    } catch (err) {
      if (err instanceof Error && err.message === "Handler timed out") {
        log.error(
          { routePath, timeoutMs: this.handlerTimeoutMs },
          "User route handler timed out",
        );
        return httpError(
          "SERVICE_UNAVAILABLE",
          `Route handler for /x/${routePath} timed out after ${this.handlerTimeoutMs}ms`,
          504,
        );
      }

      log.error({ err, routePath }, "User route handler threw an error");
      const message =
        err instanceof Error ? err.message : "Internal server error";
      return httpError("INTERNAL_ERROR", message, 500);
    }
  }
}
