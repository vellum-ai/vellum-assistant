/**
 * Default `llmCall` plugin — a passthrough that declares the pipeline
 * surface and yields to downstream middleware.
 *
 * The plugin system wraps every LLM request in the `llmCall` pipeline. The
 * actual call to {@link Provider.sendMessage} lives in the `runPipeline`
 * terminal at the call site (`agent/loop.ts`); this default's only job is to
 * contribute the manifest (`provides.llmCall: "v1"`) so other plugins can
 * negotiate against the pipeline surface.
 *
 * This plugin registers at module load — before user plugins are loaded by
 * `bootstrapPlugins()` — so it sits at the outermost layer in
 * `composeMiddleware`'s onion ordering. To keep user-registered middleware
 * reachable, the middleware forwards unconditionally via `next(args)`.
 *
 * Registered from `daemon/external-plugins-bootstrap.ts` via a side-effect
 * import so the plugin is present in the registry before
 * {@link bootstrapPlugins} walks it.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 15).
 */

import { type Plugin } from "../../types.js";
import llmCall from "./middlewares/llmCall.js";
import pkg from "./package.json" with { type: "json" };

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
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    llmCall,
  },
};
