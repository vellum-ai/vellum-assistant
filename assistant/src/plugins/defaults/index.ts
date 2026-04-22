/**
 * Aggregate export of the canonical first-party default plugins.
 *
 * Each default wraps one of the assistant's built-in pipelines with a
 * passthrough implementation so the pipeline shape is always explicit at boot
 * and at test time, even when no third-party plugins are loaded. The list is
 * the single source of truth consumed by:
 *
 * - `daemon/external-plugins-bootstrap.ts` — production/registry boot path;
 *   calls {@link registerDefaultPlugins} inside `bootstrapPlugins()`.
 * - integration tests that reset the registry and then need a
 *   production-parity state (e.g. `conversation-agent-loop.test.ts`); those
 *   call {@link resetPluginRegistryAndRegisterDefaults}.
 *
 * Keeping the list here — rather than inline in the bootstrap — avoids a
 * circular import between `plugins/registry.ts` and the bootstrap module and
 * keeps the defaults colocated with the other plugin-layer exports.
 */

import { registerPlugin, resetPluginRegistryForTests } from "../registry.js";
import { type Plugin, PluginExecutionError } from "../types.js";
import { defaultCircuitBreakerPlugin } from "./circuit-breaker.js";
import { defaultCompactionPlugin } from "./compaction.js";
import { defaultEmptyResponsePlugin } from "./empty-response.js";
import { defaultHistoryRepairPlugin } from "./history-repair.js";
import { defaultInjectorsPlugin } from "./injectors.js";
import { defaultLlmCallPlugin } from "./llm-call.js";
import { defaultMemoryRetrievalPlugin } from "./memory-retrieval.js";
import { defaultOverflowReducePlugin } from "./overflow-reduce.js";
import { defaultPersistencePlugin } from "./persistence.js";
import { defaultTitleGeneratePlugin } from "./title-generate.js";
import { defaultTokenEstimatePlugin } from "./token-estimate.js";
import { defaultToolErrorPlugin } from "./tool-error.js";
import { defaultToolExecutePlugin } from "./tool-execute.js";
import { defaultToolResultTruncatePlugin } from "./tool-result-truncate.js";

/**
 * Canonical list of first-party default plugins, in the order they should be
 * registered at boot. Registration order drives middleware composition order
 * in the pipeline runner, so additions should be appended — not inserted —
 * unless the plan explicitly requires a different position.
 */
export const ALL_DEFAULT_PLUGINS: readonly Plugin[] = [
  defaultLlmCallPlugin,
  defaultToolExecutePlugin,
  defaultToolResultTruncatePlugin,
  defaultEmptyResponsePlugin,
  defaultToolErrorPlugin,
  defaultMemoryRetrievalPlugin,
  defaultInjectorsPlugin,
  defaultTokenEstimatePlugin,
  defaultOverflowReducePlugin,
  defaultHistoryRepairPlugin,
  defaultCompactionPlugin,
  defaultCircuitBreakerPlugin,
  defaultPersistencePlugin,
  defaultTitleGeneratePlugin,
];

/**
 * Register every first-party default plugin. Idempotent — duplicate-name
 * registrations (which the registry surfaces as `PluginExecutionError` with
 * an "already registered" message) are swallowed so repeat bootstrap or test
 * setup calls do not throw. Every other error (shape failure, version
 * mismatch) re-throws.
 */
export function registerDefaultPlugins(): void {
  for (const plugin of ALL_DEFAULT_PLUGINS) {
    try {
      registerPlugin(plugin);
    } catch (err) {
      if (
        err instanceof PluginExecutionError &&
        err.message.includes("already registered")
      ) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Test-only helper: clear the plugin registry and re-register every default
 * so integration tests that exercise the full agent loop have a
 * production-parity plugin stack. Use this in `beforeEach` of tests that
 * dispatch through pipelines with a terminal that assumes the default
 * plugin handles every op (e.g. persistence, overflowReduce).
 *
 * Tests that specifically need an empty registry (pipeline-unit tests, the
 * plugin-registry tests themselves) should continue to call
 * {@link resetPluginRegistryForTests} directly.
 */
export function resetPluginRegistryAndRegisterDefaults(): void {
  resetPluginRegistryForTests();
  registerDefaultPlugins();
}
