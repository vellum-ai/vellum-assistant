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
 * Internal calls to `ContextWindowManager` remain direct — pipeline layering
 * ends at the top of the reducer, not within the forced-compaction tier.
 * The supplied `compactFn` delegates straight into the context window
 * manager, so only the tier-loop orchestration goes through the pipeline
 * runner.
 */

import type { ContextWindowCompactOptions } from "../../context/window-manager.js";
import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerState,
} from "../../daemon/context-overflow-reducer.js";
import { registerPlugin } from "../registry.js";
import {
  type Middleware,
  type OverflowReduceArgs,
  type OverflowReduceResult,
  type Plugin,
  PluginExecutionError,
} from "../types.js";

/**
 * Default middleware — implements the historical tier-loop semantics.
 *
 * The middleware intentionally ignores `next`. Overflow reduction is a
 * *terminal* behavior: there is no downstream implementation to defer to
 * when a user-supplied middleware short-circuits. Later plugins may still
 * wrap this one (outer middleware can observe each reduction iteration via
 * their own `next` callback) but the default never delegates to a
 * hypothetical base handler — the inline loop was the base.
 */
export const defaultOverflowReduceMiddleware: Middleware<
  OverflowReduceArgs,
  OverflowReduceResult
> = async function defaultOverflowReduceMiddleware(args, _next, _ctx) {
  let messages = args.messages;
  let runMessages = args.runMessages;
  let injectionMode: "full" | "minimal" = "full";
  let reducerState: ReducerState = createInitialReducerState();
  let reducerCompacted = false;
  let attempts = 0;

  while (attempts < args.maxAttempts && !reducerState.exhausted) {
    attempts++;
    args.emitActivityState();

    const step = await reduceContextOverflow(
      messages,
      {
        providerName: args.providerName,
        systemPrompt: args.systemPrompt,
        contextWindow: args.contextWindow,
        targetTokens: args.preflightBudget,
        toolTokenBudget: args.toolTokenBudget,
      },
      reducerState,
      (msgs, signal, opts: ContextWindowCompactOptions) =>
        args.compactFn(msgs, signal, opts),
      args.abortSignal,
    );

    reducerState = step.state;
    messages = step.messages;
    injectionMode = step.state.injectionMode;

    // Let the orchestrator apply compaction side effects (circuit-breaker
    // tracking, event emission, ctx mutation) before we re-inject.
    if (step.compactionResult) {
      await args.onCompactionResult(step.compactionResult);
      if (step.compactionResult.compacted) {
        reducerCompacted = true;
      }
    }

    // Rebuild runMessages via the orchestrator-supplied helper (which
    // re-runs `applyRuntimeInjections` with potentially downgraded mode
    // and freshly re-hydrated PKB/NOW blocks after compaction). We pass
    // the current reduced `messages` explicitly so the orchestrator never
    // has to read from mutable shared state to rebuild runMessages — a
    // tier that doesn't trigger compaction (tool-result truncation, media
    // stubbing) won't update `ctx.messages` on its own.
    runMessages = await args.reinjectForMode(
      messages,
      injectionMode,
      reducerCompacted,
    );

    // Re-estimate with injections included — `step.estimatedTokens` was
    // computed on bare history and doesn't account for tokens added by
    // runtime injections.
    const postInjectionTokens = args.estimatePostInjection(runMessages);
    if (postInjectionTokens <= args.preflightBudget) break;
  }

  return {
    messages,
    runMessages,
    injectionMode,
    reducerState,
    reducerCompacted,
    attempts,
  };
};

/**
 * The default plugin registered at bootstrap. No `init`/`onShutdown` —
 * registering the middleware is the only behavior.
 */
export const defaultOverflowReducePlugin: Plugin = {
  manifest: {
    name: "default-overflow-reduce",
    version: "1.0.0",
    requires: { pluginRuntime: "v1", overflowReduceApi: "v1" },
  },
  middleware: {
    overflowReduce: defaultOverflowReduceMiddleware,
  },
};

// Module-load side effect: register this default at import time so
// downstream consumers (including tests that skip `bootstrapPlugins()`)
// observe a populated registry by default. Idempotent via the swallowed
// duplicate-name check. Kept local to this module (rather than iterating
// an array in `defaults/index.ts`) so the registration only references
// the already-initialized `defaultOverflowReducePlugin` identifier —
// avoiding a TDZ crash when tests `mock.module(...)` a dependency of any
// other default plugin and directly import this file.
try {
  registerPlugin(defaultOverflowReducePlugin);
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
