/**
 * Daemon-side handlers for public_routes_list and public_routes_inspect.
 *
 * Scans the workspace routes directory for user-defined handler files (.ts, .js),
 * dynamically imports them to detect exported HTTP methods, and returns structured
 * route metadata. These handlers move the filesystem-scanning logic out of the CLI
 * and into the daemon so the CLI can be a thin IPC wrapper.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { getConfig } from "../../config/loader.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { getWorkspaceRoutesDir } from "../../util/platform.js";
import { BadRequestError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// HTTP method detection
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

/** Supported file extensions for handler modules. */
const HANDLER_EXTENSIONS = [".ts", ".js"] as const;

type HandlerExtension = (typeof HANDLER_EXTENSIONS)[number];

// ---------------------------------------------------------------------------
// DiscoveredRoute interface
// ---------------------------------------------------------------------------

interface DiscoveredRoute {
  /** Route path relative to /x/ prefix (e.g. "my-app/status"). */
  routePath: string;
  /** Absolute path to the handler file. */
  filePath: string;
  /** HTTP methods exported by the handler module. */
  methods: HttpMethod[];
  /** Optional description exported by the handler module. */
  description?: string;
  /** File size in bytes. */
  fileSize: number;
  /** Last modified time as ISO string. */
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a handler module and extract its exported HTTP methods and description.
 */
async function inspectModule(
  filePath: string,
): Promise<{ methods: HttpMethod[]; description?: string }> {
  const stat = statSync(filePath);
  const mod = (await import(`${filePath}?t=${stat.mtimeMs}`)) as Record<
    string,
    unknown
  >;

  const methods: HttpMethod[] = [];
  for (const method of HTTP_METHODS) {
    if (typeof mod[method] === "function") {
      methods.push(method);
    }
  }

  const description =
    typeof mod.description === "string" ? mod.description : undefined;

  return { methods, description };
}

/**
 * Recursively scan the routes directory for handler files (.ts, .js).
 * Returns discovered routes sorted alphabetically by route path.
 */
async function discoverRoutes(routesDir: string): Promise<DiscoveredRoute[]> {
  if (!existsSync(routesDir)) {
    return [];
  }

  const routes: DiscoveredRoute[] = [];

  function scanDir(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = HANDLER_EXTENSIONS.find((e) => entry.name.endsWith(e)) as
          | HandlerExtension
          | undefined;
        if (!ext) continue;

        const relativePath = relative(routesDir, fullPath);
        const withoutExt = relativePath.slice(0, -ext.length);

        // Convert filesystem path to route path:
        // - Strip /index suffix for index file convention
        // - Replace backslashes with forward slashes (Windows compat)
        let routePath = withoutExt.replace(/\\/g, "/");
        if (routePath.endsWith("/index")) {
          routePath = routePath.slice(0, -"/index".length);
        } else if (routePath === "index") {
          routePath = "";
        }

        routes.push({
          routePath,
          filePath: fullPath,
          methods: [],
          description: undefined,
          fileSize: 0,
          modifiedAt: "",
        });
      }
    }
  }

  scanDir(routesDir);

  // Load each module to detect exported methods and description
  for (const route of routes) {
    try {
      const stat = statSync(route.filePath);
      route.fileSize = stat.size;
      route.modifiedAt = stat.mtime.toISOString();

      const { methods, description } = await inspectModule(route.filePath);
      route.methods = methods;
      route.description = description;
    } catch {
      // If a module fails to load, keep it in the list with empty methods
    }
  }

  return routes.sort((a, b) => a.routePath.localeCompare(b.routePath));
}

/**
 * Resolve a route path to a handler file on disk.
 * Mirrors the resolution logic from UserRouteDispatcher.
 */
function resolveHandlerFile(
  routesDir: string,
  routePath: string,
): string | null {
  const basePath = join(routesDir, routePath);

  // Direct file match
  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Index file convention
  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = join(basePath, `index${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Try to get the public base URL from config.
 * Returns null if not configured (non-fatal).
 */
function tryGetPublicBaseUrl(): string | null {
  try {
    return getPublicBaseUrl(getConfig());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePublicRoutesList(_args: RouteHandlerArgs): Promise<unknown> {
  const routesDir = getWorkspaceRoutesDir();
  const discovered = await discoverRoutes(routesDir);
  const publicBase = tryGetPublicBaseUrl();

  return {
    routes: discovered.map((r) => ({
      routePath: "/x/" + r.routePath,
      methods: r.methods,
      description: r.description ?? null,
      filePath: relative(routesDir, r.filePath),
      publicUrl: publicBase ? publicBase + "/x/" + r.routePath : null,
    })),
    publicBase,
  };
}

async function handlePublicRoutesInspect(args: RouteHandlerArgs): Promise<unknown> {
  const routePath = args.queryParams?.path;
  if (!routePath) {
    throw new BadRequestError("path query param required");
  }

  const routesDir = getWorkspaceRoutesDir();
  const filePath = resolveHandlerFile(routesDir, routePath);
  if (!filePath) {
    throw new RouteError(
      `No handler file found for route path "${routePath}"`,
      "NOT_FOUND",
      404,
    );
  }

  const stat = statSync(filePath);
  const { methods, description } = await inspectModule(filePath);
  const publicBase = tryGetPublicBaseUrl();

  return {
    routePath: "/x/" + routePath,
    methods,
    description: description ?? null,
    filePath,
    publicUrl: publicBase ? publicBase + "/x/" + routePath : null,
    fileSize: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "public_routes_list",
    endpoint: "public-routes/list",
    method: "GET",
    summary: "List user-defined route handlers",
    tags: ["routes"],
    handler: handlePublicRoutesList,
  },
  {
    operationId: "public_routes_inspect",
    endpoint: "public-routes/inspect",
    method: "GET",
    summary: "Inspect a user-defined route handler",
    tags: ["routes"],
    queryParams: [{ name: "path", description: "Route path relative to /x/" }],
    handler: handlePublicRoutesInspect,
  },
];
