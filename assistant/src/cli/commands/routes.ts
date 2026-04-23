import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { Command } from "commander";

import { getConfig } from "../../config/loader.js";
import { getPublicBaseUrl } from "../../inbound/public-ingress-urls.js";
import { getWorkspaceRoutesDir } from "../../util/platform.js";
import { log } from "../logger.js";

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
 * Try to resolve the public base URL for building full endpoint URLs.
 * Returns null if no public URL is configured (non-fatal for CLI display).
 */
function tryGetPublicBaseUrl(): string | null {
  try {
    const config = getConfig();
    return getPublicBaseUrl(config);
  } catch {
    return null;
  }
}

/**
 * Format a list of HTTP methods for display, abbreviating DELETE to DEL.
 */
function formatMethods(methods: HttpMethod[]): string {
  return methods.map((m) => (m === "DELETE" ? "DEL" : m)).join(",");
}

export function registerRoutesCommand(program: Command): void {
  const routes = program
    .command("routes")
    .description(
      "Manage user-defined authenticated HTTP route handlers under /x/*",
    );

  routes.addHelpText(
    "after",
    `
User-defined routes let you expose custom HTTP endpoints by dropping handler
files into /workspace/routes/. Each file exports named HTTP method functions
(GET, POST, etc.) and becomes reachable at /x/<path>.

These routes require edge authentication — they are intended for
assistant-internal or user-facing endpoints, not for unauthenticated provider
webhooks.

Routes are managed by creating and deleting files — no add/remove commands
needed.

Examples:
  $ assistant routes list
  $ assistant routes list --json
  $ assistant routes inspect my-dashboard-api/submit`,
  );

  routes
    .command("list")
    .description("List all user-defined route handlers and their public URLs")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Scans /workspace/routes/ for handler files (.ts, .js) and displays the route
path, exported HTTP methods, optional description, and file location.

Examples:
  $ assistant routes list
  $ assistant routes list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      try {
        const routesDir = getWorkspaceRoutesDir();
        const discovered = await discoverRoutes(routesDir);

        if (opts.json) {
          const publicBase = tryGetPublicBaseUrl();
          const items = discovered.map((r) => ({
            routePath: `/x/${r.routePath}`,
            methods: r.methods,
            description: r.description ?? null,
            filePath: relative(routesDir, r.filePath),
            publicUrl: publicBase ? `${publicBase}/x/${r.routePath}` : null,
          }));
          console.log(JSON.stringify({ ok: true, routes: items }));
          return;
        }

        if (discovered.length === 0) {
          log.info("No route handlers found in /workspace/routes/.");
          log.info(
            "Create a .ts or .js file exporting named HTTP method functions (GET, POST, etc.).",
          );
          return;
        }

        const publicBase = tryGetPublicBaseUrl();

        log.info("");
        // Table header
        const routeCol = "ROUTE PATH";
        const methodsCol = "METHODS";
        const descCol = "DESCRIPTION";
        const fileCol = "FILE";

        // Calculate column widths
        const routeWidth = Math.max(
          routeCol.length,
          ...discovered.map((r) => `/x/${r.routePath}`.length),
        );
        const methodsWidth = Math.max(
          methodsCol.length,
          ...discovered.map((r) => formatMethods(r.methods).length),
        );
        const descWidth = Math.max(
          descCol.length,
          ...discovered.map((r) => (r.description ?? "").length),
        );

        const header = [
          routeCol.padEnd(routeWidth),
          methodsCol.padEnd(methodsWidth),
          descCol.padEnd(descWidth),
          fileCol,
        ].join("    ");

        log.info(`  ${header}`);

        for (const route of discovered) {
          const cols = [
            `/x/${route.routePath}`.padEnd(routeWidth),
            formatMethods(route.methods).padEnd(methodsWidth),
            (route.description ?? "").padEnd(descWidth),
            `routes/${relative(routesDir, route.filePath)}`,
          ].join("    ");
          log.info(`  ${cols}`);
        }

        log.info("");
        const countLabel = discovered.length === 1 ? "route" : "routes";
        const summary = `${discovered.length} ${countLabel}`;
        if (publicBase) {
          log.info(`  ${summary} • Public base: ${publicBase}`);
        } else {
          log.info(`  ${summary}`);
        }
        log.info("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
    });

  routes
    .command("inspect <path>")
    .description("Show details of a specific user-defined route handler")
    .option("--json", "Machine-readable JSON output")
    .addHelpText(
      "after",
      `
Arguments:
  path   Route path relative to /x/ (e.g. "my-dashboard-api/submit").
         Do not include the /x/ prefix.

Loads the handler file and displays exported methods, description, file path,
public URL, file size, and last modified time.

Examples:
  $ assistant routes inspect my-dashboard-api/submit
  $ assistant routes inspect items --json`,
    )
    .action(async (routePath: string, opts: { json?: boolean }) => {
      try {
        const routesDir = getWorkspaceRoutesDir();
        const filePath = resolveHandlerFile(routesDir, routePath);

        if (!filePath) {
          const msg = `No handler file found for route path "${routePath}"`;
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }));
          } else {
            log.error(msg);
            log.info("Expected file at one of:");
            for (const ext of HANDLER_EXTENSIONS) {
              log.info(`  ${join(routesDir, `${routePath}${ext}`)}`);
              log.info(`  ${join(routesDir, routePath, `index${ext}`)}`);
            }
          }
          process.exitCode = 1;
          return;
        }

        const stat = statSync(filePath);
        const { methods, description } = await inspectModule(filePath);
        const publicBase = tryGetPublicBaseUrl();
        const publicUrl = publicBase ? `${publicBase}/x/${routePath}` : null;

        if (opts.json) {
          console.log(
            JSON.stringify({
              ok: true,
              route: {
                routePath: `/x/${routePath}`,
                methods,
                description: description ?? null,
                filePath,
                publicUrl,
                fileSize: stat.size,
                modifiedAt: stat.mtime.toISOString(),
              },
            }),
          );
          return;
        }

        log.info("");
        log.info(`  Route:       /x/${routePath}`);
        log.info(
          `  Methods:     ${methods.join(", ") || "(none)"}  (detected from named exports)`,
        );
        if (description) {
          log.info(`  Description: ${description}`);
        }
        log.info(`  File:        ${filePath}`);
        if (publicUrl) {
          log.info(`  Public URL:  ${publicUrl}`);
        }
        log.info(`  File Size:   ${stat.size} bytes`);
        log.info(`  Modified:    ${stat.mtime.toISOString()}`);
        log.info("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: msg }));
        } else {
          log.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
      }
    });
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
