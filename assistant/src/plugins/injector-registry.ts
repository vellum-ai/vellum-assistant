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
 * Memoized order-sorted union, each injector tagged with its contributing
 * plugin so {@link getRegisteredInjectors} can filter by disabled-state at read
 * time without re-sorting. Rebuilt lazily after any registration change so the
 * sort runs once per stable registry state rather than once per turn.
 */
let cachedChain: Array<{ plugin: string; injector: Injector }> | null = null;

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
 * The order-sorted union of every registered injector whose contributing plugin
 * is currently enabled. Stable-sorted by ascending `order` (lower runs first);
 * injectors sharing an `order` keep their registration order.
 *
 * Disabled-state is consulted at read time, once per contributing plugin, via
 * {@link isPluginDisabled} — so `assistant plugins disable/enable <name>` takes
 * effect on the next turn without a daemon restart, the same contract the hook
 * and tool registries honor. The order-sorted union is memoized across the
 * filter (rebuilt only on a registration change); only the small per-plugin
 * disabled check re-runs each call.
 *
 * `effectiveEnabledPlugins` layers the per-chat plugin scope on top of the
 * global disabled check: when non-null, an injector's contributing plugin must
 * also be a member of the set or the injector is excluded for this turn. `null`
 * (or omitted) means no per-chat restriction — every globally-enabled plugin's
 * injectors run, unchanged.
 */
export function getRegisteredInjectors(
  effectiveEnabledPlugins?: Set<string> | null,
): Injector[] {
  if (cachedChain === null) {
    const pairs: Array<{ plugin: string; injector: Injector }> = [];
    for (const [plugin, injectors] of injectorsByPlugin) {
      for (const injector of injectors) pairs.push({ plugin, injector });
    }
    pairs.sort((a, b) => a.injector.order - b.injector.order);
    cachedChain = pairs;
  }
  const enabledByPlugin = new Map<string, boolean>();
  const isEnabled = (plugin: string): boolean => {
    let enabled = enabledByPlugin.get(plugin);
    if (enabled === undefined) {
      enabled =
        !isPluginDisabled(plugin) &&
        (effectiveEnabledPlugins == null ||
          effectiveEnabledPlugins.has(plugin));
      enabledByPlugin.set(plugin, enabled);
    }
    return enabled;
  };
  return cachedChain
    .filter(({ plugin }) => isEnabled(plugin))
    .map(({ injector }) => injector);
}

/** Drop every registration. Exposed for test isolation. */
export function clearInjectorRegistry(): void {
  injectorsByPlugin.clear();
  cachedChain = null;
}
