/**
 * Cache of the first-party default plugin names, primed at daemon boot from the
 * canonical {@link getAllDefaultPlugins} list (see `registerDefaultPlugins`).
 *
 * Per-chat plugin scoping unions these so a scoped chat never filters out core
 * default plugins — see `getEffectiveEnabledPluginSet`. It is a primed cache
 * rather than a hardcoded list so it can never drift as default plugins are
 * added or removed, and a dependency-free leaf so importing it never pulls the
 * defaults barrel (which reaches back into `daemon/` modules) into a consumer's
 * module-init graph.
 *
 * Priming runs at daemon startup, before any turn resolves a plugin scope. The
 * cache is empty until then; a caller that runs before boot (or a unit test)
 * sees no defaults and must prime it first.
 */

let cachedNames: ReadonlySet<string> = new Set();

/** Prime the cache from the canonical default-plugin list. Idempotent. */
export function primeDefaultPluginNames(names: Iterable<string>): void {
  cachedNames = new Set(names);
}

/** The primed first-party default plugin names (empty before boot priming). */
export function getDefaultPluginNames(): ReadonlySet<string> {
  return cachedNames;
}
