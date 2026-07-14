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
 * etc.) using the standard Web API Request/Response signature.
 *
 * Handlers receive a second `context` argument with runtime singletons
 * (event hub, assistant ID, etc.) that would otherwise be unreachable
 * from dynamically imported modules because Bun's cache-busting import
 * creates separate module instances.
 *
 * Modules are lazily loaded on first request and cached by file path +
 * mtime. When a file changes on disk, the next request reloads it via
 * Bun's dynamic `import()` with a cache-busting query parameter. A request
 * whose file does not exist 404s — nothing is registered ahead of time.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isPluginDisabled } from "../../plugins/disabled-state.js";
import { getLogger } from "../../util/logger.js";
import {
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
} from "../../util/platform.js";
import type { AssistantEventHub } from "../assistant-event-hub.js";
import { httpError } from "../http-errors.js";

const log = getLogger("user-routes");

// ---------------------------------------------------------------------------
// User route context — injected into every handler as the second argument
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to user-defined route handlers.
 *
 * Because user route modules are loaded via dynamic `import()` with
 * cache-busting query parameters, they get isolated module instances
 * and cannot import process-level singletons like the event hub
 * directly. This context bridges the gap by carrying references to
 * the daemon's real singletons.
 */
export interface UserRouteContext {
  /** The daemon's event hub singleton — use this to publish events to connected SSE clients. */
  readonly assistantEventHub: AssistantEventHub;
  /** The logical assistant ID used by the daemon (typically "self"). */
  readonly assistantId: string;
  /** Conversation operations available to route handlers (e.g. posting integration events as turns). */
  readonly conversations: RouteConversationsApi;
}

/**
 * Conversation operations exposed to route handlers. Lets integration routes
 * (webhook receivers, cron jobs, device/service callbacks) surface an inbound
 * event as a real assistant turn rather than only a client-side event.
 */
export interface RouteConversationsApi {
  /**
   * Post a message into an existing conversation as a real assistant turn.
   *
   * The turn is attributed to a dedicated integration interface (never a human
   * surface) and runs under the conversation's existing trust context — a
   * route cannot impersonate a user or elevate privilege by posting. Unknown
   * conversation ids are rejected (a route never silently creates one), and
   * posts are rate-limited per conversation to backstop runaway loops.
   *
   * Rejects with a `RouteMessageError` carrying `code`
   * (`"not_found" | "rate_limited" | "invalid"`) — catch it to map to an HTTP
   * status, or let it surface as a 500.
   */
  postMessage(
    conversationId: string,
    text: string,
  ): Promise<{ messageId: string }>;
}

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
 * The function signature that user-defined route handlers must follow.
 *
 * Handlers may accept an optional second `context` argument with runtime
 * singletons (event hub, assistant ID). Legacy handlers that only accept
 * `request` continue to work — the context is passed positionally but
 * ignored if the handler doesn't declare the parameter.
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

/** Default per-request timeout for user-defined route handlers (30 seconds). */
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/** Supported file extensions for handler modules. */
const HANDLER_EXTENSIONS = [".ts", ".js"] as const;

/** Path segment reserved for plugin-namespaced routes under `/x/`. */
const PLUGIN_ROUTE_SEGMENT = "plugins";

/**
 * Resolve an `/x/` route path to the base directory + sub-path the handler file
 * is looked up under.
 *
 * `plugins/<name>/<rest>` resolves against that plugin's own
 * `<workspaceDir>/plugins/<name>/routes/` directory (`<rest>` may be empty,
 * mapping to the namespace's `index` handler). Everything else resolves against
 * the workspace `routes/` directory. Returns `null` (caller 404s) when:
 *
 * - the path is a malformed plugin path (`plugins` with no name segment), so it
 *   never falls back to a workspace route — the `plugins/` prefix is reserved
 *   for plugin routes; or
 * - the named plugin is disabled (`.disabled` sentinel present), so a disabled
 *   plugin serves no routes even though its files remain on disk.
 */
function resolveRouteLocation(
  routePath: string,
): { routesDir: string; subPath: string } | null {
  const segments = routePath.split("/");
  if (segments[0] === PLUGIN_ROUTE_SEGMENT) {
    const pluginName = segments[1];
    if (!pluginName || isPluginDisabled(pluginName)) {
      return null;
    }
    return {
      routesDir: join(getWorkspacePluginsDir(), pluginName, "routes"),
      subPath: segments.slice(2).join("/"),
    };
  }
  return { routesDir: getWorkspaceRoutesDir(), subPath: routePath };
}

export class UserRouteDispatcher {
  private moduleCache = new Map<string, CachedModule>();
  private handlerTimeoutMs: number;
  private context: UserRouteContext;

  constructor(options: {
    handlerTimeoutMs?: number;
    context: UserRouteContext;
  }) {
    this.handlerTimeoutMs =
      options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.context = Object.freeze({ ...options.context });
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
      ? this.resolveHandlerFile(location.routesDir, location.subPath)
      : null;

    if (!filePath) {
      return httpError(
        "NOT_FOUND",
        `No route handler found for /x/${routePath}`,
        404,
      );
    }

    const mod = await this.loadModule(filePath);
    const method = request.method as HttpMethod;
    const handler = mod.handlers[method];

    if (!handler) {
      const allowed = HTTP_METHODS.filter((m) => m in mod.handlers);
      return new Response(null, {
        status: 405,
        headers: { Allow: allowed.join(", ") },
      });
    }

    return this.executeHandler(handler, request, routePath);
  }

  /**
   * Resolve a route path to a handler file on disk.
   *
   * Checks for direct file matches first (`<path>.ts`, `<path>.js`),
   * then falls back to index files (`<path>/index.ts`, `<path>/index.js`).
   *
   * Returns the absolute path to the handler file, or null if not found.
   */
  private resolveHandlerFile(
    routesDir: string,
    routePath: string,
  ): string | null {
    const basePath = join(routesDir, routePath);
    const resolved = resolve(basePath);

    // Ensure the resolved path is within the routes directory to prevent
    // any path traversal that slipped through the initial check.
    if (!resolved.startsWith(resolve(routesDir))) {
      return null;
    }

    // Direct file match: routes/<path>.ts or routes/<path>.js
    for (const ext of HANDLER_EXTENSIONS) {
      const candidate = `${resolved}${ext}`;
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    // Index file convention: routes/<path>/index.ts or routes/<path>/index.js
    for (const ext of HANDLER_EXTENSIONS) {
      const candidate = join(resolved, `index${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Load a handler module, using the mtime-based cache when possible.
   *
   * On cache miss or stale mtime, the module is re-imported via Bun's
   * dynamic `import()` with a cache-busting query parameter derived
   * from the file's current mtime.
   */
  private async loadModule(filePath: string): Promise<CachedModule> {
    const stat = statSync(filePath);
    const mtimeMs = stat.mtimeMs;

    const cached = this.moduleCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    // Cache-bust Bun's module cache by appending mtime as a query param.
    const mod = (await import(`${filePath}?t=${mtimeMs}`)) as Record<
      string,
      unknown
    >;

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
   * Execute a handler function with a per-request timeout and error boundary.
   */
  private async executeHandler(
    handler: RouteHandler,
    request: Request,
    routePath: string,
  ): Promise<Response> {
    try {
      const result = await Promise.race([
        Promise.resolve(handler(request, this.context)),
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
