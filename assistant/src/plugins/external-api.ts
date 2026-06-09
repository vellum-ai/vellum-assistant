/**
 * External plugin runtime — `globalThis.__vellumPluginRuntime` bridge.
 *
 * ⚠️ DO NOT DELETE THIS AS "UNUSED". There is intentionally NO in-repo consumer:
 * the consumers are out-of-repo, user-authored workspace plugins under
 * `<workspaceDir>/plugins/*`, which a repo-wide reference search cannot see. On
 * a `bun --compile` daemon (the shipped macOS app) this bridge is the ONLY way
 * such a plugin can reach the daemon's real `assistantEventHub` /
 * `getSecureKeyAsync` singletons — an absolute-path `import` re-loads a disjoint
 * copy (see the module-identity note below). Removing it silently breaks every
 * event-subscribing workspace plugin on the next app rebuild. This was already
 * removed once on the false "unused" assumption (PR #33825) and restored here.
 *
 * Workspace-local plugins (`<workspaceDir>/plugins/*`) get dynamic-imported by
 * {@link loadUserPlugins}. They need to call `registerPlugin()` from their
 * module body and they typically also want to read secrets, subscribe to
 * runtime events, etc.
 *
 * Importing those symbols by absolute path
 * (`/abs/path/to/assistant/src/plugins/registry.js`) works when the daemon is
 * running from source — both the daemon and the dynamic-imported plugin
 * resolve the same on-disk file and share module identity. It DOES NOT work
 * when the daemon is a `bun --compile` binary: the daemon's modules are baked
 * into the executable, and any absolute-path import re-loads a fresh disk
 * copy. `registerPlugin()` then writes into a disjoint registry instance and
 * the daemon never sees the plugin.
 *
 * The fix is to expose a single, stable handle on `globalThis` that plugins
 * read at module-load time. The daemon's bundled modules attach themselves
 * here once at startup; plugins consume the same instance regardless of how
 * the daemon was built.
 *
 * Plugins use the bridge like this:
 *
 *   const runtime = (globalThis as { __vellumPluginRuntime?: ... })
 *     .__vellumPluginRuntime;
 *   if (!runtime || runtime.version !== 1) throw new Error("...");
 *   const { registerPlugin, assistantEventHub, getSecureKeyAsync } = runtime;
 *
 * Type-only imports (`import type { Plugin } from "..."`) remain free to use
 * absolute paths or workspace-local copies — the TypeScript compiler erases
 * them and they have no module-identity effect at runtime.
 *
 * See `plugins/README.md` for the full authoring contract and
 * `assistant/examples/plugins/echo/` for a worked example.
 */

import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { registerPlugin } from "./registry.js";

/**
 * The handle plugins read from `globalThis.__vellumPluginRuntime`.
 *
 * `version` is the contract version. Plugins should assert against the
 * version they were authored against and refuse to register if they see a
 * different one — bumping it is a breaking change to the plugin surface.
 *
 * The field set is intentionally small: the most-commonly-needed symbols
 * across both static (module-load-time) and dynamic (init-time) plugin
 * lifecycle. Plugins that need richer runtime state can still receive it
 * through {@link PluginInitContext} during `init()`.
 */
export interface VellumPluginRuntime {
  readonly version: 1;
  readonly registerPlugin: typeof registerPlugin;
  readonly assistantEventHub: typeof assistantEventHub;
  readonly getSecureKeyAsync: typeof getSecureKeyAsync;
}

/** Stable globalThis key. Don't rename — plugins reference it by string. */
const RUNTIME_GLOBAL_KEY = "__vellumPluginRuntime" as const;

interface GlobalWithRuntime {
  [RUNTIME_GLOBAL_KEY]?: VellumPluginRuntime;
}

/**
 * Install the plugin runtime bridge on `globalThis`. Idempotent — repeat
 * calls are no-ops, so it's safe to invoke from tests that also touch the
 * lifecycle path.
 *
 * Must be called BEFORE {@link loadUserPlugins} runs, otherwise plugins that
 * touch `globalThis.__vellumPluginRuntime` in their module body will throw.
 */
export function installPluginRuntime(): void {
  const g = globalThis as GlobalWithRuntime;
  if (g[RUNTIME_GLOBAL_KEY]) return;
  g[RUNTIME_GLOBAL_KEY] = {
    version: 1,
    registerPlugin,
    assistantEventHub,
    getSecureKeyAsync,
  };
}

/**
 * Read the installed runtime. Returns `undefined` if {@link installPluginRuntime}
 * hasn't been called yet — plugins should treat this as a fatal error.
 *
 * Exposed mainly for tests and for the rare in-process consumer that wants
 * to read the bridge from the same module graph that installed it.
 */
export function getPluginRuntime(): VellumPluginRuntime | undefined {
  return (globalThis as GlobalWithRuntime)[RUNTIME_GLOBAL_KEY];
}

/**
 * Tear down the runtime handle. Test-only — production code never uninstalls
 * because the runtime lifetime is the daemon lifetime.
 */
export function uninstallPluginRuntimeForTests(): void {
  delete (globalThis as GlobalWithRuntime)[RUNTIME_GLOBAL_KEY];
}
