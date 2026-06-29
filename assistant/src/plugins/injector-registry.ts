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
 * Memoized order-sorted union, rebuilt lazily after any registration change so
 * the sort runs once per stable registry state rather than once per turn.
 */
let cachedChain: Injector[] | null = null;

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
  for (const injector of injectors) {
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
  cachedChain = null;
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
    cachedChain = null;
    log.info({ plugin: pluginName }, "Plugin injectors unregistered");
  }
}

/**
 * The order-sorted union of every registered injector. Stable-sorted by
 * ascending `order` (lower runs first); injectors sharing an `order` keep
 * their registration order. Memoized until the next registration change.
 */
export function getRegisteredInjectors(): Injector[] {
  if (cachedChain === null) {
    const all: Injector[] = [];
    for (const injectors of injectorsByPlugin.values()) {
      all.push(...injectors);
    }
    cachedChain = all.sort((a, b) => a.order - b.order);
  }
  return cachedChain;
}

/** Drop every registration. Exposed for test isolation. */
export function clearInjectorRegistry(): void {
  injectorsByPlugin.clear();
  cachedChain = null;
}
