/**
 * Materializes the workspace-level `@vellumai/plugin-api` shim so that
 * user plugins under `<workspaceDir>/plugins/<name>/` can resolve a
 * standard bare import:
 *
 *     import { ... } from "@vellumai/plugin-api";
 *
 * Bun's Node-style resolution walks up from the plugin directory and
 * finds `<workspaceDir>/node_modules/@vellumai/plugin-api/` — a tiny
 * shim package (~150 bytes) whose `index.js` re-exports from the
 * embedded plugin-api artifact baked into the assistant. This avoids
 * duplicating the plugin-api package per plugin while still letting
 * the assistant's compiled binary be the single source of truth for
 * the public API.
 *
 * Idempotent: safe to call on every daemon boot. The shim's contents
 * are deterministic given the embedded artifact's path; on a fresh
 * assistant binary, the path changes (`/$bunfs/root/index-<hash>.js`)
 * and the shim is overwritten to point at the new location.
 *
 * Ordering: MUST run before `loadUserPlugins()`. The shim file must
 * exist on disk before the first plugin's `import "@vellumai/plugin-api"`
 * is parsed by Bun.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import assistantPkg from "../../package.json" with { type: "json" };
import { pluginApiPath } from "../embedded/plugin-api.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("plugin-api-shim");

const PACKAGE_NAME = "@vellumai/plugin-api";

export interface PluginApiShim {
  /** Absolute path to the materialized shim package directory. */
  shimDir: string;
  /** The re-export source written to `<shimDir>/index.js`. */
  indexJs: string;
}

export async function ensurePluginApiShim(opts?: {
  /** Override the workspace root. Defaults to `getWorkspaceDir()`. */
  workspaceDir?: string;
}): Promise<PluginApiShim> {
  const workspaceDir = opts?.workspaceDir ?? getWorkspaceDir();
  const shimDir = join(workspaceDir, "node_modules", PACKAGE_NAME);

  await mkdir(shimDir, { recursive: true });

  const indexJs = `export * from ${JSON.stringify(pluginApiPath)};\n`;
  const packageJson = `${JSON.stringify(
    {
      name: PACKAGE_NAME,
      version: assistantPkg.version,
      type: "module",
      main: "./index.js",
    },
    null,
    2,
  )}\n`;

  await writeFile(join(shimDir, "index.js"), indexJs);
  await writeFile(join(shimDir, "package.json"), packageJson);

  log.info(
    { shimDir, pluginApiPath, version: assistantPkg.version },
    "plugin-api shim materialized",
  );

  return { shimDir, indexJs };
}
