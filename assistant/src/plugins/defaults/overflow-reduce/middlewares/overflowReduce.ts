import type { ContextWindowCompactOptions } from "../../../../context/window-manager.js";
import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerState,
} from "../../../../daemon/context-overflow-reducer.js";
import type {
  Middleware,
  OverflowReduceArgs,
  OverflowReduceResult,
} from "../../../types.js";

/**
 * Default middleware for the `overflowReduce` pipeline — implements the
 * historical tier-loop semantics (forced compaction, tool-result truncation,
 * media stubbing, injection downgrade) plus the post-step re-injection /
 * re-estimation dance.
 *
 * The middleware intentionally ignores `next`. Overflow reduction is a
 * *terminal* behavior: there is no downstream implementation to defer to when
 * a user-supplied middleware short-circuits. Later plugins may still wrap this
 * one (outer middleware can observe each reduction iteration via their own
 * `next` callback) but the default never delegates to a hypothetical base
 * handler — the inline loop was the base.
 */
const defaultOverflowReduceMiddleware: Middleware<
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
    // Abort check at the top of every iteration. When the pipeline runner
    // arms a timeout (or the caller aborts externally), `args.abortSignal`
    // is linked to that trigger via `linkAbortSignal`, so this check lets
    // us bail out BETWEEN iterations rather than letting another round of
    // compaction / re-injection mutate `ctx.messages` after the turn has
    // already failed. Individual `reduceContextOverflow` calls also honor
    // the signal, but without this gate a fresh iteration could still
    // start after the signal fires, since the previous one returned
    // normally before the abort propagated.
    args.abortSignal?.throwIfAborted();

    attempts++;
    args.emitActivityState();

    const basisMessages = messages;
    const step = await reduceContextOverflow(
      basisMessages,
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

    // Per-iteration compaction flag: whether THIS step just produced a
    // fresh compaction. PKB / NOW re-injection is gated on this — see the
    // reinjectForMode JSDoc for why the two signals differ.
    const stepCompacted = step.compactionResult?.compacted === true;

    // Let the orchestrator apply compaction side effects (circuit-breaker
    // tracking, event emission, ctx mutation) before we re-inject.
    if (step.compactionResult) {
      await args.onCompactionResult(step.compactionResult, basisMessages);
      if (stepCompacted) {
        reducerCompacted = true;
      }
    }

    // Second abort gate — if the side effects or the step itself took us
    // past the deadline, don't rebuild runMessages or iterate again.
    args.abortSignal?.throwIfAborted();

    // Rebuild runMessages via the orchestrator-supplied helper (which
    // re-runs `applyRuntimeInjections` with potentially downgraded mode
    // and freshly re-hydrated PKB/NOW blocks after compaction). We pass
    // the current reduced `messages` explicitly so the orchestrator never
    // has to read from mutable shared state to rebuild runMessages — a
    // tier that doesn't trigger compaction (tool-result truncation, media
    // stubbing) won't update `ctx.messages` on its own.
    //
    // `stepCompacted` and `reducerCompacted` are both passed so the
    // orchestrator can gate PKB / NOW re-injection per-iteration while
    // keeping `slackChronologicalMessages` suppressed once any iteration
    // has compacted.
    runMessages = await args.reinjectForMode(
      messages,
      injectionMode,
      stepCompacted,
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

export default defaultOverflowReduceMiddleware;
