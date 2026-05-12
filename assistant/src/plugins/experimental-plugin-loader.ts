/**
 * Experimental plugin loader — builds a {@link Plugin} object from a
 * directory that follows the `@vellumai/simple-memory` convention.
 *
 * A directory is treated as an experimental plugin when it contains a
 * `package.json` at its root. The loader walks a fixed set of interface
 * directories, dynamic-imports each surface file, and pulls the **default
 * export** out of each one — no central `register.ts`, no side-effect
 * registration. The caller (e.g. `loadUserPlugins`) hands the returned
 * object to `registerPlugin()` directly.
 *
 *     <pluginDir>/
 *       package.json              ← manifest.name comes from `name` (scope stripped)
 *       hooks/
 *         init.ts                 ← default export: (ctx) => Promise<void>     → plugin.init
 *         shutdown.ts             ← default export: () => Promise<void>        → plugin.onShutdown
 *       tools/
 *         *.ts                    ← each file's default export                 → plugin.tools[]
 *       src/                      ← internal helpers, ignored by the loader
 *
 * Prefers `.js` over `.ts` when both exist, matching the user-loader's
 * compiled-binary convention. Missing surface files are not an error: the
 * loader simply omits the corresponding Plugin field. A surface file that
 * exists but lacks a usable default export is a hard error — the caller
 * decides whether to log-and-skip or fail.
 *
 * The harness is responsible for everything beyond directory walking
 * (config validation, credential resolution, feature-flag gating,
 * `init()` invocation, tool registration). This module's only job is to
 * turn a directory into a `Plugin` object.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Plugin,
  PluginInitContext,
  PluginManifest,
  PluginToolRegistration,
} from "./types.js";

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
}

/**
 * Strip the npm scope from a package name. `@vellumai/simple-memory` →
 * `simple-memory`; an unscoped name passes through unchanged. The result
 * is used as `manifest.name` (and flows into the per-plugin storage path).
 */
function stripScope(name: string): string {
  const match = /^@[^/]+\/(.+)$/.exec(name);
  return match ? match[1]! : name;
}

/**
 * Resolve a surface file relative to the plugin root, preferring `.js`
 * over `.ts`. Returns `undefined` when neither variant exists.
 */
function findSurfaceFile(
  pluginDir: string,
  relPathWithoutExt: string,
): string | undefined {
  for (const ext of [".js", ".ts"]) {
    const candidate = join(pluginDir, `${relPathWithoutExt}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Dynamic-import `absolutePath` and return its default export. Throws when
 * the module has no default export — callers should attribute the error.
 */
async function importDefault<T>(absolutePath: string): Promise<T> {
  const url = pathToFileURL(absolutePath).href;
  const mod = (await import(url)) as { default?: T };
  if (mod.default === undefined) {
    throw new Error(
      `module ${absolutePath} has no default export — experimental plugins must default-export their interface surfaces`,
    );
  }
  return mod.default;
}

/**
 * List tool files in `<pluginDir>/tools/`, deduplicating `.js` over `.ts`
 * when both are present for the same basename. Returns absolute paths in
 * sorted order so plugin authors can rely on a deterministic registration
 * sequence within a single plugin (cross-plugin order remains the
 * registry's responsibility).
 */
function listToolFiles(toolsDir: string): string[] {
  if (!existsSync(toolsDir) || !statSync(toolsDir).isDirectory()) return [];
  const entries = readdirSync(toolsDir);
  const byBase = new Map<string, string>();
  for (const entry of entries) {
    const base =
      entry.endsWith(".js")
        ? entry.slice(0, -3)
        : entry.endsWith(".ts")
          ? entry.slice(0, -3)
          : null;
    if (base === null) continue;
    const existing = byBase.get(base);
    if (existing === undefined || (existing.endsWith(".ts") && entry.endsWith(".js"))) {
      byBase.set(base, entry);
    }
  }
  return [...byBase.values()]
    .sort()
    .map((entry) => join(toolsDir, entry));
}

/**
 * Build a {@link Plugin} from `pluginDir`. The caller MUST verify that the
 * directory contains a `package.json` before invoking this — that check
 * gates the experimental-framework branch in the user-loader and keeps the
 * legacy `register.{ts,js}` path independent.
 *
 * Throws on:
 *
 * - malformed or unreadable `package.json`,
 * - `package.json` missing a non-empty string `name`,
 * - any surface file present but lacking a default export,
 * - a `tools/*` default export that does not look like a Tool
 *   (`name` must be a string).
 *
 * Returns a `Plugin` whose `manifest` carries `{ name, version,
 * provides: {}, requires: { pluginRuntime: "v1" } }` plus the surfaces
 * the directory actually contributed. Optional `Plugin` fields stay
 * unset when the corresponding surface dir/file is missing — the harness
 * already treats those as "this plugin contributes nothing here".
 */
export async function loadExperimentalPlugin(
  pluginDir: string,
): Promise<Plugin> {
  const pkgPath = join(pluginDir, "package.json");
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `experimental plugin at ${pluginDir}: package.json could not be read or parsed: ${reason}`,
    );
  }
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new Error(
      `experimental plugin at ${pluginDir}: package.json is missing a non-empty "name"`,
    );
  }
  const name = stripScope(pkg.name);
  const version =
    typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";

  const manifest: PluginManifest = {
    name,
    version,
    provides: {},
    requires: { pluginRuntime: "v1" },
  };

  const plugin: Plugin = { manifest };

  // hooks/init
  const initPath = findSurfaceFile(pluginDir, "hooks/init");
  if (initPath !== undefined) {
    const fn = await importDefault<
      (ctx: PluginInitContext) => Promise<void>
    >(initPath);
    if (typeof fn !== "function") {
      throw new Error(
        `experimental plugin ${name}: hooks/init default export must be a function (got ${typeof fn})`,
      );
    }
    plugin.init = fn;
  }

  // hooks/shutdown
  const shutdownPath = findSurfaceFile(pluginDir, "hooks/shutdown");
  if (shutdownPath !== undefined) {
    const fn = await importDefault<() => Promise<void>>(shutdownPath);
    if (typeof fn !== "function") {
      throw new Error(
        `experimental plugin ${name}: hooks/shutdown default export must be a function (got ${typeof fn})`,
      );
    }
    plugin.onShutdown = fn;
  }

  // tools/*
  const tools: PluginToolRegistration[] = [];
  for (const toolPath of listToolFiles(join(pluginDir, "tools"))) {
    const tool = await importDefault<PluginToolRegistration>(toolPath);
    if (
      tool === null ||
      typeof tool !== "object" ||
      typeof (tool as { name?: unknown }).name !== "string"
    ) {
      throw new Error(
        `experimental plugin ${name}: ${toolPath} default export must be a Tool object with a string "name"`,
      );
    }
    tools.push(tool);
  }
  if (tools.length > 0) plugin.tools = tools;

  return plugin;
}
