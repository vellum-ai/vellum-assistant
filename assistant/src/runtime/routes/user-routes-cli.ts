/**
 * Transport-agnostic routes for inspecting user-defined route handlers.
 *
 * These complement the dispatch routes in user-routes.ts by exposing
 * discovery and inspection endpoints for CLI consumption. The filesystem
 * scanning logic that was previously in the CLI command is now here.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { getWorkspaceDir, getWorkspaceRoutesDir } from "../../util/platform.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import {
  HANDLER_EXTENSIONS,
  isReservedWorkspaceRoutePath,
  listPluginRouteRoots,
  resolveHandlerFile,
  resolveRouteLocation,
} from "./user-route-resolution.js";

// ── Constants ───────────────────────────────────────────────────────

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

type HandlerExtension = (typeof HANDLER_EXTENSIONS)[number];

// ── Schemas ─────────────────────────────────────────────────────────

const InspectParams = z
  .object({
    path: z.string().min(1),
  })
  .strict();

// ── Helpers ─────────────────────────────────────────────────────────

interface DiscoveredRoute {
  routePath: string;
  filePath: string;
  methods: HttpMethod[];
  description?: string;
  fileSize: number;
  modifiedAt: string;
}

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

  for (const route of routes) {
    try {
      const stat = statSync(route.filePath);
      route.fileSize = stat.size;
      route.modifiedAt = stat.mtime.toISOString();

      const { methods, description } = await inspectModule(route.filePath);
      route.methods = methods;
      route.description = description;
    } catch {
      // If a module fails to load, keep it with empty methods
    }
  }

  return routes.sort((a, b) => a.routePath.localeCompare(b.routePath));
}

function tryGetPublicBaseUrl(): string | null {
  try {
    const config = getConfig();
    return getPublicBaseUrl(config);
  } catch {
    return null;
  }
}

/**
 * Strip a leading `/x/` (or `x/`) and surrounding slashes from a route path so
 * `routes inspect` accepts both the bare sub-path (`ping`) and the `/x/`-prefixed
 * form that `routes list` prints (`/x/plugins/demo/status`).
 */
function normalizeInspectPath(input: string): string {
  const trimmed = input.replace(/^\/+/, "");
  return trimmed.startsWith("x/") ? trimmed.slice(2) : trimmed;
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleUserRoutesList() {
  const publicBase = tryGetPublicBaseUrl();
  const workspaceDir = getWorkspaceDir();

  const toEntry = (xPath: string, r: DiscoveredRoute) => ({
    routePath: `/x/${xPath}`,
    methods: r.methods,
    description: r.description ?? null,
    filePath: relative(workspaceDir, r.filePath),
    publicUrl: publicBase ? `${publicBase}/x/${xPath}` : null,
  });

  const routes: ReturnType<typeof toEntry>[] = [];

  // Workspace routes at `/x/<path>`. Paths shadowed by the reserved plugin
  // namespace are skipped: `resolveRouteLocation` routes those to a plugin
  // directory, so a `<workspace>/routes/plugins/…` file is never served and
  // must not be advertised here.
  for (const r of await discoverRoutes(getWorkspaceRoutesDir())) {
    if (isReservedWorkspaceRoutePath(r.routePath)) {
      continue;
    }
    routes.push(toEntry(r.routePath, r));
  }

  // Plugin routes at `/x/plugins/<name>/<sub>`, from each enabled plugin's
  // `routes/` directory (same enumeration the dispatcher resolves against).
  for (const { pluginName, routesDir } of listPluginRouteRoots()) {
    for (const r of await discoverRoutes(routesDir)) {
      const xPath = r.routePath
        ? `plugins/${pluginName}/${r.routePath}`
        : `plugins/${pluginName}`;
      routes.push(toEntry(xPath, r));
    }
  }

  routes.sort((a, b) => a.routePath.localeCompare(b.routePath));
  return { ok: true, routes };
}

async function handleUserRoutesInspect({ body = {} }: RouteHandlerArgs) {
  const routePath = normalizeInspectPath(InspectParams.parse(body).path);

  const location = routePath.includes("..")
    ? null
    : resolveRouteLocation(routePath);
  const filePath = location
    ? resolveHandlerFile(location.routesDir, location.subPath)
    : null;

  if (!filePath) {
    throw new NotFoundError(
      `No handler file found for route path "${routePath}". Run 'assistant routes list' to see available routes.`,
    );
  }

  const stat = statSync(filePath);
  const { methods, description } = await inspectModule(filePath);
  const publicBase = tryGetPublicBaseUrl();
  const publicUrl = publicBase ? `${publicBase}/x/${routePath}` : null;

  return {
    ok: true,
    route: {
      routePath: `/x/${routePath}`,
      methods,
      description: description ?? null,
      filePath: relative(getWorkspaceDir(), filePath),
      publicUrl,
      fileSize: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    },
  };
}

// ── Route definitions ───────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "user_routes_list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "user-routes/list",
    handler: handleUserRoutesList,
    summary: "List user-defined route handlers",
    description:
      "Scan workspace routes directory for handler files and return discovered routes with methods and public URLs.",
    tags: ["user-routes"],
  },
  {
    operationId: "user_routes_inspect",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    endpoint: "user-routes/inspect",
    handler: handleUserRoutesInspect,
    summary: "Inspect a user-defined route handler",
    description:
      "Load a specific handler file and return its exported methods, description, file path, public URL, and metadata.",
    tags: ["user-routes"],
    requestBody: InspectParams,
  },
];
