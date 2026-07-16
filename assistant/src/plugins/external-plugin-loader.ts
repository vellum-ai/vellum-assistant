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
 *                                   (npm scope stripped);
 *                                   peerDependencies["@vellumai/plugin-api"]
 *                                   semver range is checked against the
 *                                   running assistant version and rejects
 *                                   the plugin if unsatisfied
 *       hooks/
 *         <name>.ts               ← default export → plugin.hooks[<name>]
 *                                   (today the runtime invokes "init" at
 *                                    bootstrap and "shutdown" at teardown;
 *                                    other filenames sit in the map for
 *                                    forward compatibility)
 *       tools/
 *         *.ts                    ← each default export → plugin.tools[];
 *                                   runtime name derives from the filename
 *                                   basename
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
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";
import { z } from "zod";

import assistantPkg from "../../package.json" with { type: "json" };
import { finalizeTool } from "../tools/tool-defaults.js";
import type { Tool, ToolDefinition } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { registerPlugin } from "./registry.js";
import type {
  HookFunction,
  Plugin,
  PluginHooks,
  PluginManifest,
} from "./types.js";

const PLUGIN_API_PEER_DEP = "@vellumai/plugin-api";

const log = getLogger("external-plugin-loader");

/** Default upper bound on how long a single plugin load may take. */
const DEFAULT_IMPORT_TIMEOUT_MS = 10_000;

/**
 * Zod schema for the subset of `package.json` the external loader reads.
 *
 * - `name` is the only required field; everything else is best-effort.
 * - `peerDependencies["@vellumai/plugin-api"]` is the canonical host-compat
 *   declaration. If present, the loader checks `semver.satisfies(host, range)`
 *   against the running assistant version and rejects the plugin on
 *   mismatch. If absent, the plugin loads without a host-compat claim
 *   (with a warning).
 * - Unknown fields pass through (`passthrough`) so the loader does not
 *   destructively reshape the file when the rest of the npm ecosystem
 *   writes to it.
 */
const PluginPackageJsonSchema = z
  .object({
    name: z.string().min(1, "package.json `name` must be a non-empty string"),
    version: z.string().optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
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

export function toToolNameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

export function deriveToolName(toolFileBaseName: string): string {
  return toToolNameSegment(toolFileBaseName);
}

/**
 * Dynamic-import `absolutePath` and return its default export. Throws when
 * the module has no default export — callers attribute the error.
 *
 * Note: Bun caches dynamic `import()` by URL and does not bust on query
 * string or hash changes, so hot-reload of hook *content* within the same
 * process is limited. A process restart picks up all changes.
 */
export async function importDefault<T>(absolutePath: string): Promise<T> {
  const url = pathToFileURL(absolutePath).href;
  const mod = (await import(url)) as { default?: T };
  if (mod.default === undefined) {
    throw new Error(
      `module ${absolutePath} has no default export — external plugins must default-export their interface surfaces`,
    );
  }
  return mod.default;
}

export interface SurfaceFile {
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
export function listSurfaceDir(dir: string): SurfaceFile[] {
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
    const fn = await importDefault<HookFunction>(path);
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
  // A plugin's identity is its install directory name — the slug the plugin
  // was installed under (a marketplace slug or a GitHub path leaf). This is
  // the identity every other surface uses: `plugins list`, enable/disable,
  // per-conversation plugin scoping, and resident-skill `owner.id`. The
  // `package.json` `name` is authored by the plugin and routinely differs
  // from the slug, so keying runtime registration off it would desync the
  // registry from the identity the user toggles and the scope filters match.
  // The manifest is still required (schema-validated above) as the load gate.
  const name = basename(pluginDir);
  const version = pkg.version && pkg.version.length > 0 ? pkg.version : "0.0.0";

  // Host-compat negotiation: plugins declare their plugin-api version
  // range via standard `peerDependencies["@vellumai/plugin-api"]`. We
  // inspect the range and report unparseable / unsatisfied cases via
  // `log.error` but still load the plugin — the plugin-installation
  // flow is in flux and a strict gate here would block experimentation
  // for the customers driving the install UX. Once the install path
  // settles, the two `log.error` branches below should harden into
  // throws so a stale plugin can't silently run against a mismatched
  // host.
  //
  // If the peerDep is absent, the plugin loads without a host-compat
  // claim; we log a warning so the omission is visible at boot.
  const range = pkg.peerDependencies?.[PLUGIN_API_PEER_DEP];
  if (range !== undefined) {
    if (!semver.validRange(range)) {
      log.error(
        { pluginDir, plugin: name, peerDep: PLUGIN_API_PEER_DEP, range },
        `external plugin ${name}: peerDependencies["${PLUGIN_API_PEER_DEP}"] is not a valid semver range — loading anyway`,
      );
    } else if (
      !semver.satisfies(assistantPkg.version, range, {
        includePrerelease: true,
      })
    ) {
      log.error(
        {
          pluginDir,
          plugin: name,
          peerDep: PLUGIN_API_PEER_DEP,
          range,
          assistantVersion: assistantPkg.version,
        },
        `external plugin ${name}: peerDependencies["${PLUGIN_API_PEER_DEP}"] requires "${range}" but assistant is ${assistantPkg.version} — loading anyway`,
      );
    }
  } else {
    log.warn(
      { pluginDir, plugin: name, peerDep: PLUGIN_API_PEER_DEP },
      "external plugin missing plugin-api peerDependency — loading without host-compat claim",
    );
  }

  const manifest: PluginManifest = { name, version };
  const plugin: Plugin = { manifest };

  const hooks = await loadHooks(pluginDir, name);
  if (hooks !== undefined) plugin.hooks = hooks;

  const tools: Tool[] = [];
  for (const { name: toolName, path: toolPath } of listSurfaceDir(
    join(pluginDir, "tools"),
  )) {
    const tool = await importDefault<ToolDefinition>(toolPath);
    if (tool === null || typeof tool !== "object") {
      throw new Error(
        `external plugin ${name}: ${toolPath} default export must be an object`,
      );
    }
    tools.push(finalizeTool(tool, deriveToolName(toolName)));
  }
  if (tools.length > 0) plugin.tools = tools;

  return plugin;
}

/**
 * Build a {@link Plugin} from `pluginDir` with the same timeout +
 * per-plugin isolation contract as {@link loadExternalPlugin}, but
 * without registering it. The plugin-source watcher consumes this so it
 * can decide between first-time registration (init once, then publish) and
 * hot-reload (replace + skip init) based on what's already in the registry.
 *
 * Returns `undefined` on timeout, build failure, or abandoned surface
 * import. Never throws — failures are logged with directory attribution.
 */
export async function buildExternalPlugin(
  pluginDir: string,
  opts: LoadExternalPluginOptions = {},
): Promise<Plugin | undefined> {
  const timeoutMs = opts.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutSentinel = Symbol("external-plugin-build-timeout");
    const buildPromise = buildPluginFromDir(pluginDir);
    const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
    });
    const result = await Promise.race([buildPromise, timeoutPromise]);
    if (result === timeoutSentinel) {
      // Abandoned build — surface imports may still be running. Attach a
      // terminal `.catch` so a late rejection does not surface as an
      // unhandled-rejection crash. Callers who feed the returned plugin
      // into `registerPlugin` rely on the closed-registration latch
      // (registry.ts) to reject any stale late-arriving registration.
      buildPromise.catch(() => {
        /* swallow — see comment above */
      });
      log.warn(
        { pluginDir, timeoutMs },
        `Timed out building external plugin ${pluginDir} after ${timeoutMs}ms — skipping`,
      );
      return undefined;
    }
    return result;
  } catch (err) {
    // Per-plugin isolation: one bad external plugin must not crash the
    // daemon. Surface the failure with attribution and move on.
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, pluginDir },
      `Failed to build external plugin ${pluginDir}: ${message}`,
    );
    return undefined;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Load the external plugin at `pluginDir` and register it. Thin wrapper
 * over {@link buildExternalPlugin} that calls `registerPlugin` on the
 * built plugin, preserving the existing `loadUserPlugins` call shape.
 */
export async function loadExternalPlugin(
  pluginDir: string,
  opts: LoadExternalPluginOptions = {},
): Promise<void> {
  const plugin = await buildExternalPlugin(pluginDir, opts);
  if (plugin === undefined) {
    // buildExternalPlugin already logged the failure with attribution.
    return;
  }
  try {
    registerPlugin(plugin);
    log.info(
      { pluginDir, name: plugin.manifest.name },
      "loaded external plugin",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { err, pluginDir, plugin: plugin.manifest.name },
      `Failed to register external plugin ${pluginDir}: ${message}`,
    );
  }
}

/**
 * Parse a plugin's `package.json` manifest from disk. Returns the plugin
 * identity (its install directory name) and version, or `undefined` when the
 * `package.json` is missing, unparseable, or fails schema validation.
 *
 * Exported so the mtime cache can discover plugin identity without going
 * through the full `buildExternalPlugin` path. The identity mirrors
 * {@link buildPluginFromDir}: the directory name, not `package.json` `name`.
 */
export async function parsePluginManifest(
  pluginDir: string,
): Promise<{ name: string; version: string } | undefined> {
  const pkgPath = join(pluginDir, "package.json");
  let rawPkg: unknown;
  try {
    rawPkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(
      { err, pluginDir },
      `package.json at ${pluginDir} could not be read or parsed: ${reason}`,
    );
    return undefined;
  }
  const parsed = PluginPackageJsonSchema.safeParse(rawPkg);
  if (!parsed.success) {
    log.error(
      { err: parsed.error, pluginDir },
      `package.json at ${pluginDir} failed schema validation: ${parsed.error.message}`,
    );
    return undefined;
  }
  const pkg: PluginPackageJson = parsed.data;
  const name = basename(pluginDir);
  const version = pkg.version && pkg.version.length > 0 ? pkg.version : "0.0.0";
  return { name, version };
}
