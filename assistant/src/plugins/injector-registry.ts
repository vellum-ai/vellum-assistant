/**
 * Global runtime-injector registry.
 *
 * Runtime injectors are a first-party plugin contribution, registered the same
 * way `tools` and `routes` are: the bootstrap (`external-plugins-bootstrap.ts`)
 * reads each plugin's `injectors` field and registers it here before the
 * plugin's `init()` runs. The per-turn injection walker
 * (`collectInjectorBlocks` in `conversation-runtime-assembly.ts`) reads the
 * union via {@link getRegisteredInjectors}.
 *
 * Ordering is a pure function of each injector's `order` field:
 * {@link getRegisteredInjectors} stable-sorts the union ascending, so the
 * sequence the model sees does not depend on which plugin contributes an
 * injector or in what registration order — except as the deterministic
 * tiebreak among injectors that share an `order`, which falls back to
 * registration order (plugin registration order × each plugin's array order).
 */

import { getLogger } from "../util/logger.js";
import { isPluginDisabled } from "./disabled-state.js";
import type { Injector } from "./types.js";

const log = getLogger("injector-registry");

/**
 * Injectors contributed by each plugin, keyed by plugin name. `Map` iteration
 * preserves insertion (registration) order, and each plugin's array order is
 * preserved within its entry — together these define the pre-sort sequence
 * that {@link getRegisteredInjectors}'s stable sort uses as its tiebreak.
 */
const injectorsByPlugin = new Map<string, readonly Injector[]>();

/**
 * Memoized order-sorted union, each injector paired with its owning plugin so
 * the read-time disabled-state filter can drop a plugin's injectors. Rebuilt
 * lazily after any registration change; the sort runs once per stable registry
 * state, while the per-call filter in {@link getRegisteredInjectors} handles
 * `.disabled` toggles that occur without a registration change.
 */
let cachedSorted: Array<{ injector: Injector; pluginName: string }> | null =
  null;

/**
 * Register the injectors contributed by `pluginName`. Injector names must be
 * globally unique; a name already claimed by a *different* plugin throws.
 * Re-registering the same plugin replaces its prior set (idempotent for hot
 * reload and test re-setup), so a plugin re-running its own registration is a
 * silent replace rather than a duplicate-name throw.
 */
export function registerPluginInjectors(
  pluginName: string,
  injectors: readonly Injector[],
): void {
  const seenInContribution = new Set<string>();
  for (const injector of injectors) {
    if (seenInContribution.has(injector.name)) {
      throw new Error(
        `Plugin "${pluginName}" contributes duplicate injector name "${injector.name}"`,
      );
    }
    seenInContribution.add(injector.name);
    for (const [owner, existing] of injectorsByPlugin) {
      if (owner === pluginName) continue;
      if (existing.some((e) => e.name === injector.name)) {
        throw new Error(
          `Injector "${injector.name}" contributed by plugin "${pluginName}" is already registered by plugin "${owner}"`,
        );
      }
    }
  }
  injectorsByPlugin.set(pluginName, injectors);
  cachedSorted = null;
  log.info(
    { plugin: pluginName, count: injectors.length },
    "Plugin injectors registered",
  );
}

/**
 * Remove the injectors contributed by `pluginName`. No-op when the plugin
 * never contributed injectors, so it is safe to call on every teardown path.
 */
export function unregisterPluginInjectors(pluginName: string): void {
  if (injectorsByPlugin.delete(pluginName)) {
    cachedSorted = null;
    log.info({ plugin: pluginName }, "Plugin injectors unregistered");
  }
}

/**
 * The order-sorted union of every registered injector, excluding those
 * contributed by a currently disabled plugin. Stable-sorted by ascending
 * `order` (lower runs first); injectors sharing an `order` keep their
 * registration order. The sort is memoized until the next registration change;
 * the `.disabled` filter is applied per call so disabling a plugin drops its
 * injectors on the next turn without a restart — matching the hook and tool
 * registries (`getHooksFor` / `getPluginToolDefinitions`).
 */
export function getRegisteredInjectors(): Injector[] {
  if (cachedSorted === null) {
    const pairs: Array<{ injector: Injector; pluginName: string }> = [];
    for (const [pluginName, injectors] of injectorsByPlugin) {
      for (const injector of injectors) {
        pairs.push({ injector, pluginName });
      }
    }
    cachedSorted = pairs.sort((a, b) => a.injector.order - b.injector.order);
  }
  return cachedSorted
    .filter((entry) => !isPluginDisabled(entry.pluginName))
    .map((entry) => entry.injector);
}

/** Drop every registration. Exposed for test isolation. */
export function clearInjectorRegistry(): void {
  injectorsByPlugin.clear();
  cachedSorted = null;
}
