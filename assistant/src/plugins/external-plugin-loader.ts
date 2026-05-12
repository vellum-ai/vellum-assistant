/**
 * External plugin loader — builds a {@link Plugin} from a directory and
 * registers it with the runtime.
 *
 * The convention this loader walks is currently **experimental**: surface
 * set, manifest fields, and discovery shape may all change before the
 * framework stabilizes. We keep this module's identifiers harness-neutral
 * ("external") so the stable call path through the harness —
 * `loadUserPlugins → loadExternalPlugin → registerPlugin` — does not
 * need to be renamed when the convention shifts.
 *
 *     <pluginDir>/
 *       package.json              ← manifest.name comes from `name`
 *                                   (npm scope stripped); manifest.requires
 *                                   comes from `vellum.requires` if present
 *       hooks/
 *         init.ts                 ← default export → plugin.hooks.init
 *         shutdown.ts             ← default export → plugin.hooks.shutdown
 *       tools/
 *         *.ts                    ← each file's default export → plugin.tools[]
 *       src/                      ← internal helpers, ignored by the loader
 *
 * Per-surface, `.js` is preferred over `.ts` (compiled-binary semantics).
 * Missing surface files are silently omitted (the harness treats absent
 * fields as "this plugin contributes nothing here"). Surface files
 * present without a usable default export are a hard failure: the
 * loader logs with attribution and skips the plugin.
 *
 * This function owns the per-plugin isolation contract: it never throws,
 * times out after `importTimeoutMs`, catches any error from the build or
 * `registerPlugin` call, and logs an attributed entry. Callers can
 * `await loadExternalPlugin(...)` in a loop with no per-iteration guard.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getLogger } from "../util/logger.js";
import { registerPlugin } from "./registry.js";
import type {
  Plugin,
  PluginHooks,
  PluginInitContext,
  PluginManifest,
  PluginToolRegistration,
} from "./types.js";

const log = getLogger("external-plugin-loader");

/** Default upper bound on how long a single plugin load may take. */
const DEFAULT_IMPORT_TIMEOUT_MS = 10_000;

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly vellum?: unknown;
}

interface VellumBlock {
  readonly requires?: unknown;
}

export interface LoadExternalPluginOptions {
  /**
   * Maximum time to spend building the `Plugin` from disk before bailing.
   * The build runs to completion in the background if it eventually
   * resolves, but the loader has already moved on. Defaults to
   * {@link DEFAULT_IMPORT_TIMEOUT_MS}.
   */
  readonly importTimeoutMs?: number;
}

/**
 * Strip the npm scope from a package name. `@vellumai/simple-memory` →
 * `simple-memory`; an unscoped name passes through unchanged.
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
 * the module has no default export — callers attribute the error.
 */
async function importDefault<T>(absolutePath: string): Promise<T> {
  const url = pathToFileURL(absolutePath).href;
  const mod = (await import(url)) as { default?: T };
  if (mod.default === undefined) {
    throw new Error(
      `module ${absolutePath} has no default export — external plugins must default-export their interface surfaces`,
    );
  }
  return mod.default;
}

/**
 * List `.js`/`.ts` files under `toolsDir`, deduplicating `.js` over `.ts`
 * when both are present for the same basename. Returns absolute paths in
 * sorted order so plugin authors get a deterministic per-plugin tool
 * registration sequence; cross-plugin order remains the registry's job.
 */
function listToolFiles(toolsDir: string): string[] {
  if (!existsSync(toolsDir) || !statSync(toolsDir).isDirectory()) return [];
  const entries = readdirSync(toolsDir);
  const byBase = new Map<string, string>();
  for (const entry of entries) {
    const base =
      entry.endsWith(".js") || entry.endsWith(".ts")
        ? entry.slice(0, -3)
        : null;
    if (base === null) continue;
    const existing = byBase.get(base);
    if (
      existing === undefined ||
      (existing.endsWith(".ts") && entry.endsWith(".js"))
    ) {
      byBase.set(base, entry);
    }
  }
  return [...byBase.values()].sort().map((entry) => join(toolsDir, entry));
}

/**
 * Read `pkg.vellum.requires` if it exists and is an object. The loader
 * does not validate the shape of the returned record in this PR — that
 * lands with the `assistantVersion`-vs-`pluginRuntime` migration in a
 * follow-up.
 */
function readVellumRequires(
  pkg: PackageJson,
): Record<string, string> | undefined {
  if (pkg.vellum === null || typeof pkg.vellum !== "object") return undefined;
  const block = pkg.vellum as VellumBlock;
  if (block.requires === null || typeof block.requires !== "object") {
    return undefined;
  }
  return block.requires as Record<string, string>;
}

/**
 * Build a `Plugin` object from the directory layout. Internal — the
 * public entry point ({@link loadExternalPlugin}) wraps this in the
 * timeout/try-catch/register triple.
 */
async function buildPluginFromDir(pluginDir: string): Promise<Plugin> {
  const pkgPath = join(pluginDir, "package.json");
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `package.json at ${pluginDir} could not be read or parsed: ${reason}`,
    );
  }
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new Error(
      `package.json at ${pluginDir} is missing a non-empty "name"`,
    );
  }
  const name = stripScope(pkg.name);
  const version =
    typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";

  // Default `requires` keeps the existing v1 negotiation working for
  // plugins that have not yet opted into `vellum.requires`. Plugins that
  // set `vellum.requires` get exactly what they declared — no merge.
  const requires = readVellumRequires(pkg) ?? { pluginRuntime: "v1" };

  const manifest: PluginManifest = { name, version, requires };
  const plugin: Plugin = { manifest };

  const hooks: PluginHooks = {};
  const initPath = findSurfaceFile(pluginDir, "hooks/init");
  if (initPath !== undefined) {
    const fn = await importDefault<
      (ctx: PluginInitContext) => Promise<void>
    >(initPath);
    if (typeof fn !== "function") {
      throw new Error(
        `external plugin ${name}: hooks/init default export must be a function (got ${typeof fn})`,
      );
    }
    hooks.init = fn;
  }
  const shutdownPath = findSurfaceFile(pluginDir, "hooks/shutdown");
  if (shutdownPath !== undefined) {
    const fn = await importDefault<() => Promise<void>>(shutdownPath);
    if (typeof fn !== "function") {
      throw new Error(
        `external plugin ${name}: hooks/shutdown default export must be a function (got ${typeof fn})`,
      );
    }
    hooks.shutdown = fn;
  }
  if (hooks.init !== undefined || hooks.shutdown !== undefined) {
    plugin.hooks = hooks;
  }

  const tools: PluginToolRegistration[] = [];
  for (const toolPath of listToolFiles(join(pluginDir, "tools"))) {
    const tool = await importDefault<PluginToolRegistration>(toolPath);
    if (
      tool === null ||
      typeof tool !== "object" ||
      typeof (tool as { name?: unknown }).name !== "string"
    ) {
      throw new Error(
        `external plugin ${name}: ${toolPath} default export must be a Tool object with a string "name"`,
      );
    }
    tools.push(tool);
  }
  if (tools.length > 0) plugin.tools = tools;

  return plugin;
}

/**
 * Load the external plugin at `pluginDir` and register it.
 */
export async function loadExternalPlugin(
  pluginDir: string,
  opts: LoadExternalPluginOptions = {},
): Promise<void> {
  const timeoutMs = opts.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutSentinel = Symbol("external-plugin-load-timeout");
    const buildPromise = buildPluginFromDir(pluginDir);
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
    });
    const result = await Promise.race([buildPromise, timeoutPromise]);
    if (result === timeoutSentinel) {
      // Abandoned build — surface imports may still be running. Attach a
      // terminal `.catch` so a late rejection does not surface as an
      // unhandled-rejection crash. The closed-registration latch in
      // `registry.ts` rejects any late `registerPlugin()` call from a
      // surface module that finishes evaluating after this loader has
      // moved on.
      buildPromise.catch(() => {
        /* swallow — see comment above */
      });
      log.warn(
        { pluginDir, timeoutMs },
        `Timed out loading external plugin ${pluginDir} after ${timeoutMs}ms — skipping`,
      );
      return;
    }
    registerPlugin(result);
    log.info(
      { pluginDir, name: result.manifest.name },
      "loaded external plugin",
    );
  } catch (err) {
    // Per-plugin isolation: one bad external plugin must not crash the
    // daemon. Surface the failure with attribution and move on.
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, pluginDir },
      `Failed to load external plugin ${pluginDir}: ${message}`,
    );
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
