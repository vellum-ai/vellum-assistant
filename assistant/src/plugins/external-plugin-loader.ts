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
 *         <name>.ts               ← default export → plugin.hooks[<name>]
 *                                   (today the runtime invokes "init" at
 *                                    bootstrap and "shutdown" at teardown;
 *                                    other filenames sit in the map for
 *                                    forward compatibility)
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

import { z } from "zod";

import { getLogger } from "../util/logger.js";
import { registerPlugin } from "./registry.js";
import type {
  Plugin,
  PluginHookFn,
  PluginHooks,
  PluginManifest,
  PluginToolRegistration,
} from "./types.js";

const log = getLogger("external-plugin-loader");

/** Default upper bound on how long a single plugin load may take. */
const DEFAULT_IMPORT_TIMEOUT_MS = 10_000;

/**
 * Zod schema for the subset of `package.json` the external loader reads.
 *
 * - `name` is the only required field; everything else is best-effort.
 * - `vellum.requires` is forwarded to {@link PluginManifest.requires}
 *   verbatim (no merge with defaults) — empty objects propagate so the
 *   registry can reject under-specified plugins.
 * - Unknown fields pass through (`passthrough`) so the loader does not
 *   destructively reshape the file when the rest of the npm ecosystem
 *   writes to it.
 */
const PluginPackageJsonSchema = z
  .object({
    name: z.string().min(1, "package.json `name` must be a non-empty string"),
    version: z.string().optional(),
    vellum: z
      .object({
        requires: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type PluginPackageJson = z.infer<typeof PluginPackageJsonSchema>;

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

interface SurfaceFile {
  /** Basename without `.js`/`.ts` extension. */
  readonly name: string;
  /** Absolute path on disk. */
  readonly path: string;
}

/**
 * List every `.js`/`.ts` file directly under `dir`, deduplicating `.js`
 * over `.ts` when both are present for the same basename. Returns entries
 * sorted by basename so plugin authors get a deterministic per-plugin
 * registration sequence; cross-plugin order remains the registry's job.
 *
 * Used to walk both `hooks/` and `tools/` — neither surface needs
 * subdirectory recursion today, so this stays flat on purpose.
 */
function listSurfaceDir(dir: string): SurfaceFile[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const entries = readdirSync(dir);
  const byBase = new Map<string, string>();
  for (const entry of entries) {
    // `.d.ts` declaration files are TypeScript type-only artifacts shipped
    // alongside compiled `.js`. They have no default-exported runtime
    // function and would crash `importDefault`, so the walker filters
    // them out before the `.js`/`.ts` extension check.
    if (entry.endsWith(".d.ts")) continue;
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
  return [...byBase.keys()]
    .sort()
    .map((name) => ({ name, path: join(dir, byBase.get(name)!) }));
}

/**
 * Walk every file under `<pluginDir>/hooks/` and import each as a
 * lifecycle hook keyed by filename basename. The runtime today invokes
 * `init` at bootstrap and `shutdown` at teardown; other filenames are
 * loaded into the map for forward compatibility with future lifecycle
 * events but stay inert.
 */
async function loadHooks(
  pluginDir: string,
  pluginName: string,
): Promise<PluginHooks | undefined> {
  const files = listSurfaceDir(join(pluginDir, "hooks"));
  if (files.length === 0) return undefined;
  const hooks: PluginHooks = {};
  for (const { name, path } of files) {
    const fn = await importDefault<PluginHookFn>(path);
    if (typeof fn !== "function") {
      throw new Error(
        `external plugin ${pluginName}: hooks/${name} default export must be a function (got ${typeof fn})`,
      );
    }
    hooks[name] = fn;
  }
  return hooks;
}

/**
 * Build a `Plugin` object from the directory layout. Internal — the
 * public entry point ({@link loadExternalPlugin}) wraps this in the
 * timeout/try-catch/register triple.
 */
async function buildPluginFromDir(pluginDir: string): Promise<Plugin> {
  const pkgPath = join(pluginDir, "package.json");
  let rawPkg: unknown;
  try {
    rawPkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `package.json at ${pluginDir} could not be read or parsed: ${reason}`,
    );
  }
  const parsed = PluginPackageJsonSchema.safeParse(rawPkg);
  if (!parsed.success) {
    throw new Error(
      `package.json at ${pluginDir} failed schema validation: ${parsed.error.message}`,
    );
  }
  const pkg: PluginPackageJson = parsed.data;
  const name = stripScope(pkg.name);
  const version = pkg.version && pkg.version.length > 0 ? pkg.version : "0.0.0";

  // Default `requires` keeps the existing v1 negotiation working for
  // plugins that have not yet opted into `vellum.requires`. Plugins that
  // set `vellum.requires` get exactly what they declared — no merge.
  const requires = pkg.vellum?.requires ?? { pluginRuntime: "v1" };

  const manifest: PluginManifest = { name, version, requires };
  const plugin: Plugin = { manifest };

  const hooks = await loadHooks(pluginDir, name);
  if (hooks !== undefined) plugin.hooks = hooks;

  const tools: PluginToolRegistration[] = [];
  for (const { path: toolPath } of listSurfaceDir(join(pluginDir, "tools"))) {
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
