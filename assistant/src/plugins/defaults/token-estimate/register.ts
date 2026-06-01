/**
 * Default `tokenEstimate` plugin.
 *
 * The plugin's middleware is a passthrough — it calls `next(args)` and returns
 * the result unchanged. The actual estimate lives in the terminal handler in
 * `./terminal.ts`, which is wired in as the pipeline's `terminal` argument by
 * `runPipeline` call sites in `daemon/conversation-agent-loop.ts`. This
 * separation matters: the default plugin is registered before any user plugin
 * (defaults load first in `bootstrapPlugins()`), which puts it at the
 * OUTERMOST position of the onion chain. If the default middleware were to
 * invoke the terminal directly without calling `next`, it would shadow every
 * later-registered plugin. The passthrough lets user middleware that wraps the
 * default (e.g. a doubler, a provider-native `countTokens` override)
 * participate normally.
 */

import { type Plugin } from "../../types.js";
import tokenEstimate from "./middlewares/tokenEstimate.js";
import pkg from "./package.json" with { type: "json" };

/**
 * Default `tokenEstimate` plugin. Registered by
 * {@link bootstrapPlugins} on daemon startup so the pipeline always has a
 * terminal handler even when no other plugin contributes one.
 */
export const defaultTokenEstimatePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    tokenEstimate,
  },
};
