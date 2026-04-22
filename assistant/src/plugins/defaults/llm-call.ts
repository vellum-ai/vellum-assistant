/**
 * Default `llmCall` plugin — the passthrough terminal that delegates to
 * {@link Provider.sendMessage}.
 *
 * The plugin system wraps every LLM request in the `llmCall` pipeline. This
 * default ensures the pipeline always has a terminal to fall through to when
 * no other plugin short-circuits or overrides it: it reconstitutes the
 * provider call from {@link LLMCallArgs} and returns the raw
 * {@link ProviderResponse} unchanged.
 *
 * Registered from `daemon/external-plugins-bootstrap.ts` via a side-effect
 * import so the plugin is present in the registry before
 * {@link bootstrapPlugins} walks it.
 *
 * Design doc: `.private/plans/agent-plugin-system.md` (PR 15).
 */

import type { LLMCallArgs, LLMCallResult, Plugin } from "../types.js";

/**
 * The default LLM-call plugin. Its sole contribution is the `llmCall`
 * middleware, which calls `args.provider.sendMessage(...)` with the exact
 * fields `args` carries and returns the provider response as-is.
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
      _next,
      _ctx,
    ): Promise<LLMCallResult> {
      return args.provider.sendMessage(
        args.messages,
        args.tools,
        args.systemPrompt,
        args.options,
      );
    },
  },
};
