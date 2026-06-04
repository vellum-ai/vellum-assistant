/**
 * Aggregate export of the first-party default plugins.
 *
 * Each default wraps one of the assistant's built-in pipelines with a
 * passthrough implementation so the pipeline shape is always explicit at boot
 * and at test time, even when no third-party plugins are loaded.
 *
 * Consumers:
 *
 * - `daemon/external-plugins-bootstrap.ts` — the daemon's `initializePlugins()`
 *   calls {@link registerDefaultPlugins} explicitly at startup, before
 *   `loadUserPlugins()` closes the registration window, so the defaults compose
 *   innermost (ahead of any user plugins). `bootstrapPlugins()` replays it;
 *   idempotent, so already-registered defaults are skipped.
 * - integration tests that reset the registry and then need a
 *   production-parity state (e.g. `conversation-agent-loop.test.ts`); those
 *   call {@link resetPluginRegistryAndRegisterDefaults}.
 *
 * Each `defaults/<name>/register.ts` module only builds and exports its
 * `Plugin` object; registration is centralized here. The plugin identifiers
 * are dereferenced inside {@link registerDefaultPlugins} at call time, once
 * every module has finished initializing, so importing this aggregator does no
 * registration work.
 */

import { memoryV3ShadowPlugin } from "../../memory/v3/shadow-plugin.js";
import { registerPlugin, resetPluginRegistryForTests } from "../registry.js";
import { type Plugin, PluginExecutionError } from "../types.js";
import { defaultCircuitBreakerPlugin } from "./circuit-breaker/register.js";
import { defaultCompactionPlugin } from "./compaction/register.js";
import { defaultEmptyResponsePlugin } from "./empty-response/register.js";
import { defaultHistoryRepairPlugin } from "./history-repair/register.js";
import { defaultInjectorsPlugin } from "./injectors/register.js";
import { defaultMemoryRetrievalPlugin } from "./memory-retrieval/register.js";
import { defaultOverflowReducePlugin } from "./overflow-reduce/register.js";
import { defaultTitleGeneratePlugin } from "./title-generate/register.js";
import { defaultToolErrorPlugin } from "./tool-error/register.js";
import { defaultToolResultTruncatePlugin } from "./tool-result-truncate/register.js";

/**
 * Full set of first-party default plugins. Used by
 * {@link registerDefaultPlugins} to drive the registration loop; the array
 * order is the registration order, which determines onion order for middleware
 * composition (defaults innermost, user plugins outermost).
 *
 * Returned by a function rather than a top-level `const` so the array
 * contents are read at call time, after every imported plugin identifier is
 * guaranteed initialized.
 */
function getAllDefaultPlugins(): readonly Plugin[] {
  return [
    defaultToolResultTruncatePlugin,
    defaultEmptyResponsePlugin,
    defaultToolErrorPlugin,
    defaultMemoryRetrievalPlugin,
    defaultInjectorsPlugin,
    defaultOverflowReducePlugin,
    defaultHistoryRepairPlugin,
    defaultCompactionPlugin,
    defaultCircuitBreakerPlugin,
    defaultTitleGeneratePlugin,
    memoryV3ShadowPlugin,
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
 * plugin handles every op (e.g. overflowReduce).
 *
 * Tests that specifically need an empty registry (pipeline-unit tests, the
 * plugin-registry tests themselves) should continue to call
 * {@link resetPluginRegistryForTests} directly.
 */
export function resetPluginRegistryAndRegisterDefaults(): void {
  resetPluginRegistryForTests();
  registerDefaultPlugins();
}
