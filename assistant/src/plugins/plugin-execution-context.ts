/**
 * Plugin execution context. Tracks which plugin's code is currently running.
 *
 * Host APIs exposed to plugins through `@vellumai/plugin-api` sometimes need to
 * know *which* plugin is calling them so they can scope their behavior to that
 * plugin (e.g. {@link ../plugin-api/resolve-credential.resolveCredential} limits
 * a plugin to its own credentials). A plugin's manifest name is not threaded
 * through every host call, so every seam that enters a plugin's code marks the
 * plugin as "in context" for the duration of that invocation via an
 * {@link AsyncLocalStorage}: the pipeline that invokes its hook, the executor
 * that runs its tool, and the dispatcher that serves its
 * `/x/plugins/<name>/` routes. Host APIs read {@link getCurrentPluginName} to
 * recover it.
 *
 * The store propagates across `await` boundaries, so a plugin that awaits a
 * host API deep inside its hook/tool/route body is still seen as in context.
 * That propagation is why the same seams clear the context on the way back out
 * to host code ({@link runOutsidePluginContext}): a plugin route can start a
 * whole conversation turn, and the host tools and workspace hooks that turn
 * runs are not the plugin's code, so they must not inherit its identity.
 *
 * When no plugin is in context (host-internal callers, the CLI, tests), the
 * store is empty and scoped APIs fall back to their unscoped behavior.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface PluginExecutionContext {
  /**
   * Manifest name of the plugin whose hook, tool, or route is currently
   * executing.
   */
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
 * Run `fn` with no plugin in context, whatever the caller is running inside.
 *
 * Host code reached *from* a plugin (a default tool executed during a turn a
 * plugin route started, a workspace hook fired inside a plugin's hook) is not
 * the plugin's code and must not borrow its identity: scoped APIs would
 * attribute the host's work to that plugin, or refuse it for being out of the
 * plugin's scope. The seams that dispatch non-plugin code call this so the
 * store reflects who is really running rather than who started the chain.
 */
export function runOutsidePluginContext<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * Name of the plugin whose hook, tool, or route is currently executing, or
 * `undefined` when no plugin is in context.
 */
export function getCurrentPluginName(): string | undefined {
  return storage.getStore()?.pluginName;
}
