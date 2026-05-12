/**
 * Materializes the workspace-level `@vellumai/plugin-api` shim so that
 * user plugins under `<workspaceDir>/plugins/<name>/` can resolve a
 * standard bare import:
 *
 *     import { ... } from "@vellumai/plugin-api";
 *
 * Bun's Node-style resolution walks up from the plugin directory and
 * finds `<workspaceDir>/node_modules/@vellumai/plugin-api/` — a tiny
 * shim package whose `index.js` re-binds the plugin-api namespace that
 * the assistant already loaded into its module graph (and parked on
 * `globalThis` under {@link PLUGIN_API_REGISTRY_KEY}).
 *
 * This avoids duplicating the plugin-api package per plugin while still
 * letting the assistant's compiled binary be the single source of truth
 * for the public API. The runtime mechanism is uniform across:
 *   - JIT / Docker: plugin-api loads from source, shim re-binds via globalThis
 *   - `bun --compile` (macOS bare-metal): plugin-api ships inside the
 *     binary's regular code graph (Bun's bundler resolves
 *     `import * as pluginApi from "../plugin-api/index.js"` at compile
 *     time, inlining relative imports), shim re-binds via globalThis
 *
 * Idempotent: safe to call repeatedly. The shim's contents are
 * deterministic given the runtime export list — fresh exports (added in
 * later PRs) automatically expand the generated `index.js`.
 *
 * Called from {@link loadUserPlugins} at the top of its body so the
 * ordering constraint (shim exists before any plugin's
 * `import "@vellumai/plugin-api"` is parsed) is enforced by code, not
 * by a docstring in `lifecycle.ts`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import assistantPkg from "../../package.json" with { type: "json" };
import {
  PLUGIN_API_EXPORTS,
  PLUGIN_API_REGISTRY_KEY,
} from "../embedded/plugin-api.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("plugin-api-shim");

const PACKAGE_NAME = "@vellumai/plugin-api";

/**
 * Build the body of the workspace shim's `index.js`. Exported so the
 * smoke test can assert against the same generator the daemon uses.
 */
export function buildShimSource(
  exports: readonly string[] = PLUGIN_API_EXPORTS,
  registryKey: symbol = PLUGIN_API_REGISTRY_KEY,
): string {
  const description = registryKey.description ?? "";
  const lines = [
    `const api = globalThis[Symbol.for(${JSON.stringify(description)})];`,
    ...exports.map((name) => `export const ${name} = api.${name};`),
  ];
  return `${lines.join("\n")}\n`;
}

export async function ensurePluginApiShim(opts?: {
  /** Override the workspace root. Defaults to `getWorkspaceDir()`. */
  workspaceDir?: string;
}): Promise<void> {
  const workspaceDir = opts?.workspaceDir ?? getWorkspaceDir();
  const shimDir = join(workspaceDir, "node_modules", PACKAGE_NAME);

  await mkdir(shimDir, { recursive: true });

  const indexJs = buildShimSource();
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
    {
      shimDir,
      exports: PLUGIN_API_EXPORTS,
      version: assistantPkg.version,
    },
    "plugin-api shim materialized",
  );
}
