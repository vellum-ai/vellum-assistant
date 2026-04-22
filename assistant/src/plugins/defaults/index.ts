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
 *
 * Each `defaults/<name>.ts` module self-registers at module load via a
 * local side effect. That keeps registrations attached to the already-
 * initialized per-file plugin identifier, so the TDZ trap that bit the
 * previous top-level `registerDefaultPlugins()` call in this file cannot
 * recur when `defaults/index.ts` is loaded mid-cycle through the
 * `memory-retrieval.ts` → … → `pipeline.ts` → `defaults/index.ts`
 * cycle. The per-file side effects are idempotent — duplicate-name
 * registrations are swallowed — so {@link registerDefaultPlugins} and
 * {@link resetPluginRegistryAndRegisterDefaults} remain safe to call
 * after a registry reset.
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
 *
 * Implemented as a function (rather than a top-level `const` array) to avoid
 * a TDZ hazard: `memory-retrieval.ts` transitively imports
 * `plugins/pipeline.ts` (via `daemon/conversation-runtime-assembly.ts` →
 * … → `agent/loop.ts`), and `pipeline.ts` side-effect-imports this file.
 * When the first loader of `defaults/index.ts` is anything in that cycle,
 * `defaults/index.ts` starts evaluating BEFORE `memory-retrieval.ts`
 * finishes — so a top-level `ALL_DEFAULT_PLUGINS = [...memoryRetrievalPlugin...]`
 * declaration trips the live-binding TDZ. A function body defers the
 * reads until call time, by which point every imported plugin identifier
 * is guaranteed initialized.
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

// Module-load registration is now performed by each `defaults/<name>.ts`
// file via its own local side effect. The old `registerDefaultPlugins()`
// call that used to live at the end of this module walked the plugin
// array at the module's top level — which TDZ-crashed whenever
// `defaults/index.ts` was loaded mid-cycle (e.g. through
// `memory-retrieval.ts` → `conversation-runtime-assembly.ts` →
// … → `agent/loop.ts` → `plugins/pipeline.ts` → `defaults/index.ts`):
// the array referenced `defaultMemoryRetrievalPlugin` before its
// declaration line had evaluated. Moving registration into each
// per-file module avoids that hazard because each file's local side
// effect only references its own `defaultXyzPlugin` identifier, which
// is initialized by the time its side-effect block runs. Registration
// order is preserved because `defaults/index.ts` imports each default
// in the canonical order returned by {@link getAllDefaultPlugins}.
//
// {@link registerDefaultPlugins} and
// {@link resetPluginRegistryAndRegisterDefaults} remain exported as
// belt-and-braces helpers for tests that clear the registry mid-run.
