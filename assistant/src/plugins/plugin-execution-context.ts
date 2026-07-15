/**
 * Plugin execution context — tracks which plugin's code is currently running.
 *
 * Host APIs exposed to plugins through `@vellumai/plugin-api` sometimes need to
 * know *which* plugin is calling them so they can scope their behavior to that
 * plugin (e.g. {@link ../plugin-api/resolve-credential.resolveCredential} limits
 * a plugin to its own credentials). A plugin's manifest name is not threaded
 * through every host call, so the pipeline that invokes a plugin's hook — and
 * the tool executor that runs a plugin's tool — mark the plugin as "in context"
 * for the duration of that invocation via an {@link AsyncLocalStorage}. Host
 * APIs read {@link getCurrentPluginName} to recover it.
 *
 * The store propagates across `await` boundaries, so a plugin that awaits a
 * host API deep inside its hook/tool body is still seen as in context. When no
 * plugin is in context (host-internal callers, the CLI, tests), the store is
 * empty and scoped APIs fall back to their unscoped behavior.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface PluginExecutionContext {
  /** Manifest name of the plugin whose hook or tool is currently executing. */
  pluginName: string;
}

const storage = new AsyncLocalStorage<PluginExecutionContext>();

/**
 * Run `fn` with `pluginName` marked as the plugin currently in context. The
 * returned value (including a promise) carries the context across its async
 * continuations, so callers pass the promise straight to a timeout wrapper
 * without losing the binding.
 */
export function runInPluginContext<T>(pluginName: string, fn: () => T): T {
  return storage.run({ pluginName }, fn);
}

/**
 * Name of the plugin whose hook or tool is currently executing, or `undefined`
 * when no plugin is in context.
 */
export function getCurrentPluginName(): string | undefined {
  return storage.getStore()?.pluginName;
}
