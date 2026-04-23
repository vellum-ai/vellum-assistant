/**
 * Aggregate export of the first-party default plugins.
 *
 * Each default wraps one of the assistant's built-in pipelines with a
 * passthrough implementation so the pipeline shape is always explicit at boot
 * and at test time, even when no third-party plugins are loaded.
 *
 * Consumers:
 *
 * - `daemon/external-plugins-bootstrap.ts` — production/registry boot path;
 *   calls {@link registerDefaultPlugins} inside `bootstrapPlugins()`.
 * - integration tests that reset the registry and then need a
 *   production-parity state (e.g. `conversation-agent-loop.test.ts`); those
 *   call {@link resetPluginRegistryAndRegisterDefaults}.
 *
 * Each `defaults/<name>.ts` module self-registers at module load via a local
 * side effect. Importing this aggregator (or any individual default file)
 * populates the registry — the self-registration is idempotent, and so are
 * {@link registerDefaultPlugins} and {@link resetPluginRegistryAndRegisterDefaults}.
 * Per-file self-registration is what keeps registration attached to each
 * file's own already-initialized plugin identifier, so importing
 * `defaults/index.ts` mid-cycle (e.g. through the
 * `memory-retrieval.ts` → … → `pipeline.ts` → `defaults/index.ts`
 * chain) does not trip a TDZ.
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
 * Full set of first-party default plugins. Used by
 * {@link registerDefaultPlugins} to drive the idempotent re-registration
 * loop; actual registration-order in the registry is determined by the
 * module-load side effects in each per-file default (whichever loader
 * evaluates a file first wins, later attempts are swallowed as duplicates).
 *
 * Returned by a function rather than a top-level `const` so the array
 * contents are read at call time, after every imported plugin identifier is
 * guaranteed initialized.
 */
export function getAllDefaultPlugins(): readonly Plugin[] {
  return [
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
}

/**
 * Register every first-party default plugin. Idempotent — duplicate-name
 * registrations (which the registry surfaces as `PluginExecutionError` with
 * an "already registered" message) are swallowed so repeat bootstrap or test
 * setup calls do not throw. Every other error (shape failure, version
 * mismatch) re-throws.
 *
 * In practice every call after the first is a no-op: each default's
 * module-load side effect registers itself the first time its file is
 * imported, which for production happens via `pipeline.ts`'s side-effect
 * import of this aggregator.
 */
export function registerDefaultPlugins(): void {
  for (const plugin of getAllDefaultPlugins()) {
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
