/**
 * Global background-job-handler registry.
 *
 * Background-job handlers are a first-party plugin contribution, registered the
 * same way `tools`, `routes`, and `injectors` are: the bootstrap
 * (`external-plugins-bootstrap.ts`) reads each plugin's `jobHandlers` field and
 * registers it here before the plugin's `init()` runs. The general job worker's
 * registration entry (`jobs/register-job-handlers.ts`) reads the union via
 * {@link getRegisteredJobHandlers} and forwards each handler into the worker's
 * dispatch table (`registerJobHandler` in `persistence/jobs-worker.ts`).
 *
 * Unlike injectors, job handlers carry no order: dispatch is a keyed lookup by
 * job `type`, so a `type` must be globally unique across every plugin. The
 * registry rejects a duplicate `type` the same way the injector registry rejects
 * a duplicate injector name. Contribution order is irrelevant — the worker's
 * dispatch map is keyed by type — so {@link getRegisteredJobHandlers} returns the
 * union in plain registration order with no sort.
 */

import { getLogger } from "../util/logger.js";
import type { JobHandlerEntry } from "./types.js";

const log = getLogger("job-handler-registry");

/**
 * Job handlers contributed by each plugin, keyed by plugin name. `Map` iteration
 * preserves insertion (registration) order; within a plugin the array order is
 * preserved. Neither affects dispatch (keyed by `type`).
 */
const jobHandlersByPlugin = new Map<string, readonly JobHandlerEntry[]>();

/**
 * Register the job handlers contributed by `pluginName`. Job-handler `type`s must
 * be globally unique; a `type` already claimed by a *different* plugin throws.
 * Re-registering the same plugin replaces its prior set (idempotent for hot
 * reload and test re-setup), so a plugin re-running its own registration is a
 * silent replace rather than a duplicate-type throw.
 */
export function registerPluginJobHandlers(
  pluginName: string,
  handlers: readonly JobHandlerEntry[],
): void {
  const seenInContribution = new Set<string>();
  for (const entry of handlers) {
    if (seenInContribution.has(entry.type)) {
      throw new Error(
        `Plugin "${pluginName}" contributes duplicate job-handler type "${entry.type}"`,
      );
    }
    seenInContribution.add(entry.type);
    for (const [owner, existing] of jobHandlersByPlugin) {
      if (owner === pluginName) continue;
      if (existing.some((e) => e.type === entry.type)) {
        throw new Error(
          `Job-handler type "${entry.type}" contributed by plugin "${pluginName}" is already registered by plugin "${owner}"`,
        );
      }
    }
  }
  jobHandlersByPlugin.set(pluginName, handlers);
  log.info(
    { plugin: pluginName, count: handlers.length },
    "Plugin job handlers registered",
  );
}

/**
 * Remove the job handlers contributed by `pluginName`. No-op when the plugin
 * never contributed job handlers, so it is safe to call on every teardown path.
 */
export function unregisterPluginJobHandlers(pluginName: string): void {
  if (jobHandlersByPlugin.delete(pluginName)) {
    log.info({ plugin: pluginName }, "Plugin job handlers unregistered");
  }
}

/**
 * The union of every registered plugin's job-handler contributions, in
 * registration order. `type`s are globally unique (enforced at registration), so
 * the consumer can forward each entry into the worker's keyed dispatch table
 * without further dedupe.
 */
export function getRegisteredJobHandlers(): JobHandlerEntry[] {
  const all: JobHandlerEntry[] = [];
  for (const handlers of jobHandlersByPlugin.values()) {
    all.push(...handlers);
  }
  return all;
}

/** Drop every registration. Exposed for test isolation. */
export function clearJobHandlerRegistry(): void {
  jobHandlersByPlugin.clear();
}
