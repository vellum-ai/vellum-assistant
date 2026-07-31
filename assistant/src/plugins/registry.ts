/**
 * Plugin registry — tracks registered plugins by name and delegates hook
 * registration to {@link ../hooks/registry.ts}.
 *
 * `registerPlugin` validates a plugin manifest, records its name (so
 * `getRegisteredPlugins` can enumerate registered plugins), and forwards the
 * plugin's hooks to the hooks registry. The hook surface itself lives in
 * `hooks/registry.ts`; this module owns only the plugin-name bookkeeping.
 */

import {
  registerPluginHooks,
  resetHookRegistryForTests,
  unregisterPluginHooks,
} from "../hooks/registry.js";
import { type Plugin, PluginExecutionError } from "./types.js";

// ─── Internal state ──────────────────────────────────────────────────────────

/**
 * Plugin names that have been registered, in registration order. Used by
 * `getRegisteredPlugins` to provide the full plugin list to
 * `bootstrapPlugins` (for test-registered plugins) and for test assertions.
 */
const registeredPlugins = new Map<string, Plugin>();

/**
 * Latch that closes the per-boot registration window. No longer used in
 * production (user plugins go through the mtime cache, not `registerPlugin`),
 * but preserved for test compatibility.
 */
let registrationClosed = false;

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Validate and register a plugin's hooks. Throws {@link PluginExecutionError}
 * if the manifest is malformed. Delegates hook registration to
 * {@link registerPluginHooks} in the hooks registry. Also tracks the plugin
 * name for `getRegisteredPlugins` test assertions.
 */
export function registerPlugin(plugin: Plugin): void {
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
  // Duplicate-name check — runs BEFORE the closed-registration check so
  // `registerDefaultPlugins()` (which replays every default) keeps seeing
  // the familiar "already registered" error it catches and swallows.
  if (registeredPlugins.has(name)) {
    throw new PluginExecutionError(
      `plugin ${name} is already registered`,
      name,
    );
  }
  // Closed-registration check — rejects a genuinely new plugin that arrives
  // after `closeRegistration`. No longer used in production (user plugins go
  // through the mtime cache), but preserved for test compatibility.
  if (registrationClosed) {
    throw new PluginExecutionError(
      `plugin ${name} cannot register: plugin registration is closed (late arrival after loadUserPlugins() returned)`,
      name,
    );
  }

  registeredPlugins.set(name, plugin);

  if (plugin.hooks) {
    registerPluginHooks(name, plugin.hooks);
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * All plugins registered so far, in registration order. In production this
 * returns only the default plugins (registered by `registerDefaultPlugins`).
 * Test fixtures registered via `registerPlugin` are also included.
 */
export function getRegisteredPlugins(): Plugin[] {
  return Array.from(registeredPlugins.values());
}

/**
 * Close the per-boot registration window. No-op in production (user plugins
 * go through the mtime cache), but preserved for test compatibility.
 */
export function closeRegistration(): void {
  registrationClosed = true;
}

/**
 * Remove a plugin's hooks from the hook registry and forget its name. Used by
 * the bootstrap failure path and tests.
 */
export function unregisterPlugin(name: string): void {
  registeredPlugins.delete(name);
  unregisterPluginHooks(name);
}

// ─── Test hooks ──────────────────────────────────────────────────────────────

/**
 * Clear the plugin name set and the hook registry. Test-only.
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
  resetHookRegistryForTests();
  registrationClosed = false;
}
