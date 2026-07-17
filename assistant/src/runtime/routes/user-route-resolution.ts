/**
 * Shared path resolution for `/x/*` user routes.
 *
 * Both the request dispatcher (`user-route-dispatcher.ts`) and the CLI
 * discovery surface (`user-routes-cli.ts`) resolve `/x/` paths to on-disk
 * handler files through this module, so what the CLI lists can never drift
 * from what the dispatcher actually serves.
 *
 * Two locations back the surface:
 * - `<workspaceDir>/routes/<path>` — workspace routes, served at `/x/<path>`.
 * - `<workspaceDir>/plugins/<name>/routes/<path>` — a plugin's routes, served
 *   in that plugin's reserved namespace at `/x/plugins/<name>/<path>`.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isPluginDisabled } from "../../plugins/disabled-state.js";
import {
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
} from "../../util/platform.js";

/** Supported file extensions for handler modules (`.js` preferred over `.ts`). */
export const HANDLER_EXTENSIONS = [".ts", ".js"] as const;

/** Path segment reserved for plugin-namespaced routes under `/x/`. */
export const PLUGIN_ROUTE_SEGMENT = "plugins";

export interface RouteLocation {
  /** Absolute directory the handler file is resolved under. */
  routesDir: string;
  /** Path within `routesDir`, relative and without the `/x/` prefix. */
  subPath: string;
}

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
export function resolveRouteLocation(routePath: string): RouteLocation | null {
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

/**
 * Resolve a sub-path within `routesDir` to a handler file on disk.
 *
 * Checks for direct file matches first (`<path>.ts`, `<path>.js`), then falls
 * back to index files (`<path>/index.ts`, `<path>/index.js`). Returns the
 * absolute path to the handler file, or `null` if not found. Rejects any path
 * that escapes `routesDir` (traversal backstop).
 */
export function resolveHandlerFile(
  routesDir: string,
  subPath: string,
): string | null {
  const resolved = resolve(join(routesDir, subPath));

  if (!resolved.startsWith(resolve(routesDir))) {
    return null;
  }

  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = `${resolved}${ext}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const ext of HANDLER_EXTENSIONS) {
    const candidate = join(resolved, `index${ext}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * True when a workspace `/x/<path>` collides with the reserved plugin prefix
 * (`plugins` or `plugins/…`). Such a file lives under `<workspaceDir>/routes/`
 * but is shadowed by the plugin namespace and never served, so discovery must
 * exclude it — {@link resolveRouteLocation} routes the same path to a plugin
 * directory instead.
 */
export function isReservedWorkspaceRoutePath(routePath: string): boolean {
  return (
    routePath === PLUGIN_ROUTE_SEGMENT ||
    routePath.startsWith(`${PLUGIN_ROUTE_SEGMENT}/`)
  );
}

/**
 * Enumerate enabled workspace plugins that ship a `routes/` directory, for
 * route discovery. Mirrors {@link resolveRouteLocation}'s plugin resolution —
 * same base directory, same disabled-sentinel gate — so discovery and dispatch
 * agree on which plugin routes exist.
 */
export function listPluginRouteRoots(): {
  pluginName: string;
  routesDir: string;
}[] {
  const pluginsDir = getWorkspacePluginsDir();
  if (!existsSync(pluginsDir)) {
    return [];
  }
  const roots: { pluginName: string; routesDir: string }[] = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || isPluginDisabled(entry.name)) {
      continue;
    }
    const routesDir = join(pluginsDir, entry.name, "routes");
    if (existsSync(routesDir) && statSync(routesDir).isDirectory()) {
      roots.push({ pluginName: entry.name, routesDir });
    }
  }
  return roots;
}
