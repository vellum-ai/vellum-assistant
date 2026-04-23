/**
 * Plugin registry with manifest validation and capability-based API versioning.
 *
 * Plugins declare the assistant capabilities they need via
 * `manifest.requires` (a `{ capability: version }` map). The registry checks
 * each entry against {@link ASSISTANT_API_VERSIONS} — the canonical table of
 * capability → supported-version-list pairs the assistant exposes — and
 * refuses to register plugins that ask for a version the assistant does not
 * support.
 *
 * Registration is order-preserving: {@link getRegisteredPlugins},
 * {@link getMiddlewaresFor}, and (secondarily) {@link getInjectors} all reflect
 * the order in which {@link registerPlugin} was called, which in turn
 * determines onion order for middleware composition in the pipeline runner.
 *
 * This module does not call `Plugin.init()` — that is the job of the
 * bootstrap (see PR 14). It also does not wire the registry into the daemon;
 * later PRs introduce consumers.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 13).
 */

import {
  type Injector,
  type PipelineMiddlewareMap,
  type PipelineName,
  type Plugin,
  PluginExecutionError,
} from "./types.js";

/**
 * Capability table declaring which plugin-facing API versions the assistant
 * runtime exposes. Each capability maps to the list of supported semver-lite
 * tags (currently a single `"v1"` per capability).
 *
 * New capabilities must be added here AND in their corresponding pipeline /
 * runtime module so plugins can negotiate against them. Removing a version
 * tag is a breaking change — all consumers in the plugin ecosystem relying on
 * it will fail to register until they update their `requires` map.
 *
 * The `pluginRuntime` capability is the base runtime API every plugin must
 * negotiate for; the remaining entries mirror {@link PipelineName} and the
 * top-level context APIs plugins most commonly consume.
 */
export const ASSISTANT_API_VERSIONS: Record<string, string[]> = {
  // Runtime APIs every plugin interacts with at some level. `memoryApi` is the
  // broader memory-subsystem capability (distinct from the `memoryRetrieval`
  // pipeline, which gets its own `memoryRetrievalApi` entry below).
  pluginRuntime: ["v1"],
  memoryApi: ["v1"],
  compactionApi: ["v1"],
  persistenceApi: ["v1"],

  // Per-pipeline APIs. One entry for every slot in {@link PipelineName} that
  // isn't already covered by the runtime-APIs block above (`compaction` and
  // `persistence` live there because plugins commonly interact with them
  // outside a pipeline middleware context).
  turnApi: ["v1"],
  llmCallApi: ["v1"],
  toolExecuteApi: ["v1"],
  memoryRetrievalApi: ["v1"],
  historyRepairApi: ["v1"],
  tokenEstimateApi: ["v1"],
  overflowReduceApi: ["v1"],
  titleGenerateApi: ["v1"],
  toolResultTruncateApi: ["v1"],
  emptyResponseApi: ["v1"],
  toolErrorApi: ["v1"],
  circuitBreakerApi: ["v1"],
};

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * Registered plugins keyed by `manifest.name`. A `Map` preserves insertion
 * order, which the registry relies on for middleware composition and
 * `getRegisteredPlugins()` output.
 */
const registeredPlugins = new Map<string, Plugin>();

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Validate and register a plugin. Throws {@link PluginExecutionError} if:
 *
 * - `manifest`, `manifest.name`, `manifest.version`, or `manifest.requires`
 *   are missing.
 * - a plugin with the same name is already registered.
 * - any entry in `manifest.requires` names an unknown capability or a version
 *   the assistant does not expose.
 *
 * On success the plugin is appended to the registry in the order this
 * function is called. This function does NOT invoke `plugin.init()` — that
 * runs in the bootstrap sequence (PR 14).
 */
export function registerPlugin(plugin: Plugin): void {
  // Basic shape / required-field validation. The type system already enforces
  // most of this at compile time; these runtime checks guard against
  // JS-level callers and malformed manifests loaded dynamically.
  if (!plugin || typeof plugin !== "object") {
    throw new PluginExecutionError(
      "registerPlugin requires a Plugin object",
      undefined,
    );
  }
  const manifest = plugin.manifest;
  if (!manifest || typeof manifest !== "object") {
    throw new PluginExecutionError("plugin manifest is missing", undefined);
  }
  const name = manifest.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new PluginExecutionError(
      "plugin manifest.name is required",
      undefined,
    );
  }
  // Plugin names flow into filesystem paths (e.g. `plugins-data/<name>/` in
  // the bootstrap's `ensurePluginStorageDir`), so they must not contain path
  // separators, `..`, or other characters that could escape the parent
  // directory. Restrict to lowercase-kebab-case, which is the convention used
  // by every first-party plugin and prevents path-traversal by construction.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    throw new PluginExecutionError(
      `plugin manifest.name "${name}" must be kebab-case (lowercase letters, digits, and single hyphens)`,
      name,
    );
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new PluginExecutionError(
      `plugin ${name} manifest.version is required`,
      name,
    );
  }
  if (!manifest.requires || typeof manifest.requires !== "object") {
    throw new PluginExecutionError(
      `plugin ${name} manifest.requires is required`,
      name,
    );
  }

  // Duplicate-name check — plugins must be uniquely addressable in logs,
  // storage paths, and error messages.
  if (registeredPlugins.has(name)) {
    throw new PluginExecutionError(
      `plugin ${name} is already registered`,
      name,
    );
  }

  // Capability negotiation. Every plugin must negotiate against
  // `pluginRuntime`; we enforce that by requiring an entry to exist rather
  // than special-casing it here, so the per-entry mismatch error is uniform.
  if (!("pluginRuntime" in manifest.requires)) {
    throw new PluginExecutionError(
      `plugin ${name} must declare requires.pluginRuntime (e.g. "v1")`,
      name,
    );
  }

  for (const [api, requiredVersion] of Object.entries(manifest.requires)) {
    const supported = ASSISTANT_API_VERSIONS[api];
    if (!supported || !supported.includes(requiredVersion)) {
      const exposed = supported ? supported.join(", ") : "(none)";
      throw new PluginExecutionError(
        `plugin ${name} requires ${api}@${requiredVersion}, assistant exposes ${exposed}`,
        name,
      );
    }
  }

  registeredPlugins.set(name, plugin);
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * All plugins registered so far, in registration order. Consumers must treat
 * the returned array as a read-only snapshot — mutating it does not mutate
 * the registry.
 */
export function getRegisteredPlugins(): Plugin[] {
  return Array.from(registeredPlugins.values());
}

/**
 * Collect the middleware each registered plugin contributes for the given
 * pipeline, in registration order. Consumers feed the returned array into the
 * pipeline runner's `composeMiddleware` helper (PR 12), which applies the
 * outermost-first convention.
 *
 * Plugins that don't declare a middleware for `pipeline` are skipped.
 */
export function getMiddlewaresFor<P extends PipelineName>(
  pipeline: P,
): PipelineMiddlewareMap[P][] {
  const out: PipelineMiddlewareMap[P][] = [];
  for (const plugin of registeredPlugins.values()) {
    const middleware = plugin.middleware?.[pipeline];
    if (middleware) {
      out.push(middleware);
    }
  }
  return out;
}

/**
 * Flatten every registered plugin's `injectors` array and sort the result by
 * `order` ascending. Two injectors with the same `order` retain their relative
 * registration order (stable sort via `Array.prototype.sort`).
 */
export function getInjectors(): Injector[] {
  const out: Injector[] = [];
  for (const plugin of registeredPlugins.values()) {
    if (plugin.injectors && plugin.injectors.length > 0) {
      out.push(...plugin.injectors);
    }
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

/**
 * Remove a plugin from the registry. Invoked from the bootstrap's failure path
 * after {@link Plugin.onShutdown} and contribution teardown have run, so
 * {@link getMiddlewaresFor} and {@link getInjectors} no longer expose a
 * plugin whose `init()` aborted mid-bootstrap. Without this, every subsequent
 * pipeline invocation would re-enter the uninitialized plugin's middleware.
 * Safe to call on an already-absent name (no-op).
 */
export function unregisterPlugin(name: string): void {
  registeredPlugins.delete(name);
}

// ─── Test hooks ──────────────────────────────────────────────────────────────

/**
 * Clear the registry. Test-only — throws when invoked outside a test
 * environment so application code can never accidentally wipe the registry
 * at runtime. The guard recognizes `BUN_TEST=1` (set automatically by bun's
 * test runner) and `NODE_ENV=test` (the Node.js convention used elsewhere
 * in the codebase).
 */
export function resetPluginRegistryForTests(): void {
  const isTest =
    process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
  if (!isTest) {
    throw new PluginExecutionError(
      "resetPluginRegistryForTests may only be called in test environments",
      undefined,
    );
  }
  registeredPlugins.clear();
}
