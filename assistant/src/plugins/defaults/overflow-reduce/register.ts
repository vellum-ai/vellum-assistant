/**
 * Default `overflowReduce` plugin — extracted verbatim from the inline
 * preflight reducer loop that previously lived in
 * `daemon/conversation-agent-loop.ts` (the `while (preflightAttempts < …)`
 * block around lines 1045–1156 before PR 23).
 *
 * The plugin owns the reducer tier-loop (forced compaction, tool-result
 * truncation, media stubbing, injection downgrade) and the post-step
 * re-injection / re-estimation dance. Orchestrator-specific coupling
 * (activity emission, circuit-breaker tracking, compaction-result
 * application, runtime injection reassembly) is threaded in through the
 * callbacks carried on {@link OverflowReduceArgs}; the plugin itself has no
 * access to the agent-loop context object.
 *
 * The forced-compaction tier runs through the orchestrator-supplied
 * `compactFn`, which routes into the `compaction` plugin pipeline so
 * registered compaction middleware observes reducer-initiated invocations
 * alongside the orchestrator-owned call sites. Non-compaction tiers
 * (tool-result truncation, media stubbing, injection downgrade) remain
 * in-process: they mutate message arrays directly without crossing a
 * pipeline boundary. The reducer itself runs under the `overflowReduce`
 * pipeline, so the full layering is `overflowReduce` → reducer tier loop
 * → (for the forced-compaction tier only) nested `compaction` pipeline.
 */

import { type Plugin } from "../../types.js";
import defaultOverflowReduceMiddleware from "./middlewares/overflowReduce.js";
import pkg from "./package.json" with { type: "json" };

/**
 * The default plugin registered at bootstrap. No `init`/`onShutdown` —
 * registering the middleware is the only behavior.
 */
export const defaultOverflowReducePlugin: Plugin = {
  manifest: {
    name: pkg.name,
    version: pkg.version,
  },
  middleware: {
    overflowReduce: defaultOverflowReduceMiddleware,
  },
};
