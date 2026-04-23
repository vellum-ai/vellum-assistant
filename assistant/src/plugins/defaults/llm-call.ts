/**
 * Default `llmCall` plugin — a true passthrough that declares the pipeline
 * surface and always yields to downstream middleware.
 *
 * The plugin system wraps every LLM request in the `llmCall` pipeline. The
 * actual call to {@link Provider.sendMessage} lives in the `runPipeline`
 * terminal at the call site (`agent/loop.ts`); this default's only job is to
 * contribute the manifest (`provides.llmCall: "v1"`) so other plugins can
 * negotiate against the pipeline surface.
 *
 * Because this plugin is registered at module load — BEFORE user plugins are
 * loaded by `bootstrapPlugins()` — it sits at the outermost layer in
 * `composeMiddleware`'s onion ordering. If its middleware called
 * `provider.sendMessage` directly (instead of `next(args)`) it would
 * short-circuit the chain and silently disable every user-registered
 * `llmCall` middleware in production. The middleware therefore just forwards
 * to `next(args)`.
 *
 * Registered from `daemon/external-plugins-bootstrap.ts` via a side-effect
 * import so the plugin is present in the registry before
 * {@link bootstrapPlugins} walks it.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 15).
 */

import { registerPlugin } from "../registry.js";
import {
  type LLMCallArgs,
  type LLMCallResult,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * The default LLM-call plugin. Its `llmCall` middleware is a passthrough that
 * forwards to `next(args)` unchanged so any user-registered middleware
 * (registered later, inner in the onion) still runs and the terminal at the
 * call site performs the actual `provider.sendMessage(...)` call.
 *
 * Manifest declares `provides.llmCall: "v1"` so other plugins can negotiate
 * against the pipeline surface and `requires.pluginRuntime: "v1"` to satisfy
 * the registry's mandatory capability check.
 */
export const defaultLlmCallPlugin: Plugin = {
  manifest: {
    name: "default-llm-call",
    version: "1.0.0",
    provides: { llmCall: "v1" },
    requires: { pluginRuntime: "v1" },
  },
  middleware: {
    llmCall: async function defaultLlmCall(
      args: LLMCallArgs,
      next,
      _ctx,
    ): Promise<LLMCallResult> {
      return next(args);
    },
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultLlmCallPlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultLlmCallPlugin);
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
