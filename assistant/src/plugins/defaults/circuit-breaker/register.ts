/**
 * Default `circuitBreaker` plugin.
 *
 * Replicates the inline compaction circuit-breaker logic that previously
 * lived in `daemon/conversation-agent-loop.ts`: three consecutive summary-LLM
 * failures open the circuit for a one-hour cooldown, and any successful
 * compaction resets the counter.
 *
 * The plugin is a thin wrapper over the state container passed in
 * `CircuitBreakerArgs.state`. The {@link Conversation} owns the underlying
 * fields (`consecutiveCompactionFailures`, `compactionCircuitOpenUntil`)
 * because dev-only playground routes (`POST /playground/reset-compaction-circuit`,
 * `POST /playground/inject-compaction-failures`) read and mutate them
 * directly. Keeping ownership on the conversation lets this plugin stay a
 * pure wrapper while preserving those hatches.
 *
 * The `key` parameter is carried through for multi-circuit futures but the
 * default plugin currently bundles all circuit state into the `state`
 * container; the key is attached to the log record via the pipeline runner.
 */

import { registerPlugin } from "../../registry.js";
import { type Plugin, PluginExecutionError } from "../../types.js";
import circuitBreaker from "./middlewares/circuitBreaker.js";
import pkg from "./package.json" with { type: "json" };

/**
 * Default plugin registered at daemon startup. Consumers negotiate against
 * `circuitBreakerApi@v1` via the registry's capability table.
 */
export const defaultCircuitBreakerPlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },

  middleware: {
    circuitBreaker,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultCircuitBreakerPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultCircuitBreakerPlugin);
} catch (err) {
  if (
    err instanceof PluginExecutionError &&
    err.message.includes("already registered")
  ) {
    // already registered — expected when both index.ts and the direct
    // file are imported in the same process
  } else {
    throw err;
  }
}
