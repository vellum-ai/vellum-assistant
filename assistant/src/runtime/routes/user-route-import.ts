/**
 * Import a user/plugin route module so its helpers match the files on disk.
 *
 * Bun caches every imported helper independently. Cache-busting only the
 * entry file (`import(file?t=mtime)`) re-binds it to whatever helpers are
 * already in the registry. That is how a new route that imports a new export
 * from `src/http.ts` 500s with "Export named 'requireNumber' not found" while
 * `/frame` (still on the old http.ts surface) keeps answering 200.
 *
 * Hooks and tools already treat the whole plugin directory as the reload
 * unit (`plugins/source-fingerprint.ts`). Routes must do the same: when the
 * entry file's mtime moves, evict every source file in that tree before the
 * next import, so the new entry cannot pair with a stale helper.
 */

import { statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { snapshotPluginSource } from "../../plugins/source-fingerprint.js";
import { evictModule } from "../../plugins/surface-import.js";
import { getWorkspaceRoutesDir } from "../../util/platform.js";

/**
 * Directory whose source files must stay mutually consistent with this
 * handler. An installed or default plugin uses the plugin root (so `src/`
 * helpers evict with `routes/`). Workspace routes use the workspace
 * `routes/` directory.
 */
export function routeSourceRoot(routesDir: string): string {
  if (routesDir === getWorkspaceRoutesDir()) {
    return routesDir;
  }
  return dirname(routesDir);
}

/**
 * Infer the source root from a handler path when the caller has no
 * {@link routeSourceRoot} (the route-host worker only sees `filePath`).
 */
export function sourceRootForHandler(filePath: string): string {
  const marker = `${sep}routes${sep}`;
  const idx = filePath.lastIndexOf(marker);
  if (idx !== -1) {
    return filePath.slice(0, idx);
  }
  return dirname(filePath);
}

/**
 * Drop every source module under `sourceRoot` from the runtime registry,
 * including query-string aliases (`file.ts?t=mtime`) the dispatcher uses to
 * cache-bust the entry file.
 */
export function evictRouteSourceTree(sourceRoot: string): void {
  const { evictionPaths } = snapshotPluginSource(sourceRoot);
  for (const path of evictionPaths) {
    evictModule(path);
  }
  evictRegistryAliases(sourceRoot);
}

function evictRegistryAliases(sourceRoot: string): void {
  const prefix = sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`;
  const fileUrlPrefix = pathToFileURL(prefix).href;
  for (const key of Object.keys(require.cache)) {
    if (!keyBelongsToTree(key, sourceRoot, prefix, fileUrlPrefix)) {
      continue;
    }
    delete require.cache[key];
  }
}

function keyBelongsToTree(
  key: string,
  sourceRoot: string,
  prefix: string,
  fileUrlPrefix: string,
): boolean {
  const bare = key.split("?")[0] ?? key;
  if (bare.includes("/node_modules/") || bare.includes("/node_modules?")) {
    return false;
  }
  if (
    bare === sourceRoot ||
    bare.startsWith(prefix) ||
    bare.startsWith(fileUrlPrefix)
  ) {
    return true;
  }
  if (bare.startsWith("file:")) {
    try {
      const asPath = fileURLToPath(bare);
      return asPath === sourceRoot || asPath.startsWith(prefix);
    } catch {
      return false;
    }
  }
  return false;
}

/** Dynamic-import a handler, cache-busted by the file's current mtime. */
export async function importRouteModule(
  filePath: string,
): Promise<Record<string, unknown>> {
  const mtimeMs = statSync(filePath).mtimeMs;
  return (await import(`${filePath}?t=${mtimeMs}`)) as Record<string, unknown>;
}
