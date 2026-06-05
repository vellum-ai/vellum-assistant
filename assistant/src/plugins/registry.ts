/**
 * Plugin registry with manifest validation.
 *
 * Host-compat negotiation lives in the plugin's `package.json`
 * `peerDependencies["@vellumai/plugin-api"]` semver range — the
 * external-plugin loader checks it against the assistant version at
 * load time. This module owns the rest of the manifest validation
 * contract: name/version presence, duplicate-name detection, and the
 * closed-registration latch that protects `bootstrapPlugins()` from
 * late-arriving registrations.
 *
 * Registration is order-preserving: {@link getRegisteredPlugins} and
 * {@link getHooksFor} reflect the order in which {@link registerPlugin} was
 * called, which in turn determines the order plugin hooks run.
 *
 * This module does not call `Plugin.init()` — that is the job of the
 * bootstrap. It also does not wire the registry into the daemon.
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import {
  type Plugin,
  PluginExecutionError,
  type PluginHookFn,
} from "./types.js";

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * Registered plugins keyed by `manifest.name`. A `Map` preserves insertion
 * order, which the registry relies on for hook ordering and
 * `getRegisteredPlugins()` output.
 */
const registeredPlugins = new Map<string, Plugin>();

/**
 * Latch that closes the per-boot registration window. Flipped to `true` by
 * {@link closeRegistration} once `loadUserPlugins()` has returned. After that,
 * any attempt to register a *new* plugin throws — this is the safety net
 * against a user plugin whose dynamic `import()` was timed out but whose
 * top-level `await` later resolves and still tries to call
 * {@link registerPlugin}. Without the latch such a late arrival would land in
 * the registry after `bootstrapPlugins()` has already walked it, leaving the
 * plugin visible in the registry with its `init()` hook never invoked.
 */
let registrationClosed = false;

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Validate and register a plugin. Throws {@link PluginExecutionError} if:
 *
 * - `manifest`, `manifest.name`, or `manifest.version` are missing.
 * - a plugin with the same name is already registered.
 * - registration has been closed by {@link closeRegistration}.
 *
 * Host-compat is checked upstream by the external-plugin loader against
 * the plugin's `peerDependencies["@vellumai/plugin-api"]` semver range —
 * the registry does not re-validate it here.
 *
 * On success the plugin is appended to the registry in the order this
 * function is called. This function does NOT invoke `plugin.init()` — that
 * runs in the bootstrap sequence.
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
  // Duplicate-name check — plugins must be uniquely addressable in logs,
  // storage paths, and error messages. Runs BEFORE the closed-registration
  // check so `registerDefaultPlugins()` (which replays every default even
  // after the registration window closes) keeps seeing the familiar
  // "already registered" error it catches and swallows.
  if (registeredPlugins.has(name)) {
    throw new PluginExecutionError(
      `plugin ${name} is already registered`,
      name,
    );
  }

  // Closed-registration check — rejects a genuinely new plugin that arrives
  // after {@link closeRegistration}. The canonical offender is a user plugin
  // whose dynamic `import()` was timed out in `loadUserPlugins()` but whose
  // module evaluation eventually completes and still calls this function.
  if (registrationClosed) {
    throw new PluginExecutionError(
      `plugin ${name} cannot register: plugin registration is closed (late arrival after loadUserPlugins() returned)`,
      name,
    );
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
 * Collect every registered plugin's hook for the given name, in
 * registration order. Plugins that don't declare a hook for `name` are
 * skipped. Used by the daemon to invoke chain-style hooks like
 * `user-prompt-submit` where each plugin's hook may transform a shared
 * context.
 *
 * The `TCtx` generic mirrors {@link PluginHookFn}'s — callers parameterize
 * over the concrete context type their hook receives. Hooks that mutate
 * the context in place return `void`; hooks that return a new context
 * replace the threaded value for the next hook in the chain.
 */
export function getHooksFor<TCtx = unknown>(
  name: string,
): PluginHookFn<TCtx>[] {
  const out: PluginHookFn<TCtx>[] = [];
  for (const plugin of registeredPlugins.values()) {
    const hook = plugin.hooks?.[name];
    if (hook) {
      out.push(hook as PluginHookFn<TCtx>);
    }
  }
  return out;
}

/**
 * Close the per-boot registration window. After this call, any attempt to
 * register a genuinely new plugin throws a {@link PluginExecutionError}.
 * Re-registering an already-registered plugin still hits the duplicate-name
 * check first (so idempotent callers like `registerDefaultPlugins()` keep
 * working unchanged).
 *
 * Called by `loadUserPlugins()` immediately before it returns so the
 * `bootstrapPlugins()` invariant ("registry has been fully populated for this
 * boot cycle") cannot be violated by a user plugin whose dynamic `import()`
 * timed out mid-load but whose top-level `await` resolves later and still
 * reaches `registerPlugin()`. Idempotent.
 */
export function closeRegistration(): void {
  registrationClosed = true;
}

/**
 * Remove a plugin from the registry. Invoked from the bootstrap's failure path
 * after {@link Plugin.onShutdown} and contribution teardown have run, so the
 * registry no longer exposes a plugin whose `init()` aborted mid-bootstrap.
 * Safe to call on an already-absent name (no-op).
 */
export function unregisterPlugin(name: string): void {
  registeredPlugins.delete(name);
}

export function getRegisteredPlugin(name: string): Plugin | undefined {
  return registeredPlugins.get(name);
}

export function setRegisteredPlugin(plugin: Plugin): void {
  registeredPlugins.set(plugin.manifest.name, plugin);
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
  // Re-open the registration window so subsequent tests can register plugins
  // again. Without this, the latch set by a prior `closeRegistration()` call
  // would leak across test cases and reject legitimate registrations.
  registrationClosed = false;
}
