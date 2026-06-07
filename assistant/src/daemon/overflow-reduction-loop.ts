import type { ContextWindowConfig } from "../config/schemas/inference.js";
import type {
  ContextWindowCompactOptions,
  ContextWindowResult,
} from "../context/window-manager.js";
import type { Message } from "../providers/types.js";
import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerState,
} from "./context-overflow-reducer.js";
import type { InjectionMode } from "./conversation-runtime-assembly.js";

/**
 * Input to the overflow-reduction loop. Captures everything the reducer
 * tier loop needs, including the message history, reducer configuration,
 * and side-effect callbacks that bridge the loop back to the orchestrator's
 * mutable per-turn state (context-window manager, activity emitter, runtime
 * injection reassembly, memory reinjection).
 *
 * The callbacks are supplied by the orchestrator because the reducer loop
 * needs to coordinate with state that lives on the `Conversation`
 * (message mutation, compaction event emission, circuit breaker tracking,
 * injection block reassembly). Keeping them as explicit callbacks keeps the
 * loop free of any dependency on the agent-loop context object.
 */
export interface OverflowReduceArgs {
  /** Bare persisted message history (the reducer applies results to a copy
   *  of this array). */
  readonly messages: Message[];
  /** Current run-time message array with runtime injections applied. */
  readonly runMessages: Message[];
  /** System prompt used for post-step token estimation. */
  readonly systemPrompt: string;
  /** Provider name used for token estimation (calibration provider key). */
  readonly providerName: string;
  /** Context window config (drives compaction behavior). */
  readonly contextWindow: ContextWindowConfig;
  /** Token budget the reducer must get below (preflight budget). */
  readonly preflightBudget: number;
  /** Tool-token overhead included in every estimation call. */
  readonly toolTokenBudget?: number;
  /** Maximum reducer iterations before the loop exits unconditionally. */
  readonly maxAttempts: number;
  /** Abort signal threaded through compaction calls. */
  readonly abortSignal?: AbortSignal;
  /**
   * Compaction callback — the loop never owns the ContextWindowManager
   * instance. The orchestrator supplies this closure so the loop can
   * delegate the forced-compaction tier without crossing the infra
   * boundary on its own.
   */
  readonly compactFn: (
    messages: Message[],
    signal: AbortSignal | undefined,
    options: unknown,
  ) => Promise<ContextWindowResult>;
  /**
   * Invoked before each reducer iteration to emit the `context_compacting`
   * activity state. The orchestrator owns activity emission because the
   * signal is trust/channel aware.
   */
  readonly emitActivityState: () => void;
  /**
   * Invoked after each reducer step that produced a successful compaction.
   * Handles circuit-breaker tracking, event emission, and context mutation.
   */
  readonly onCompactionResult: (
    result: ContextWindowResult,
    compactedBasis?: Message[],
  ) => void | Promise<void>;
  /**
   * Invoked after each step to rebuild `runMessages` from the step's
   * reduced history with the requested injection mode. The orchestrator
   * owns this helper so the full per-turn injection options object doesn't
   * leak into the loop. The current reduced messages array is passed
   * explicitly so the orchestrator doesn't need to read mutable shared
   * state. Returns the new `runMessages`.
   *
   * Re-injection self-resolves every per-turn block (including the Slack
   * chronological transcript, which it loads scoped by the conversation's
   * current compaction boundary), so the loop's compaction signals don't
   * need to be threaded in.
   */
  readonly reinjectForMode: (
    messages: Message[],
    mode: InjectionMode,
  ) => Promise<Message[]>;
  /**
   * Invoked after each step to post-estimate the rebuilt `runMessages`.
   * Pulled out so the orchestrator controls how estimation is performed
   * (and which fields feed it) without the loop reimplementing it.
   */
  readonly estimatePostInjection: (runMessages: Message[]) => number;
}

/** Output of the overflow-reduction loop. */
export interface OverflowReduceResult {
  /** Final reduced `ctx.messages` value. */
  readonly messages: Message[];
  /** Final `runMessages` with re-applied runtime injections. */
  readonly runMessages: Message[];
  /** Final injection mode (may be `"minimal"` if the downgrade tier fired). */
  readonly injectionMode: InjectionMode;
  /** Accumulated reducer state at exit. */
  readonly reducerState: ReducerState;
  /** How many iterations of the tier loop executed. */
  readonly attempts: number;
}

/**
 * Run the context-overflow reducer tier loop — forced compaction, tool-result
 * truncation, media stubbing, injection downgrade — plus the post-step
 * re-injection / re-estimation convergence check.
 *
 * The forced-compaction tier is delegated through `args.compactFn`; the other
 * tiers mutate the message array directly. After each step the orchestrator
 * rebuilds `runMessages` via `args.reinjectForMode` and the loop re-estimates
 * the post-injection token count, exiting once it fits the preflight budget,
 * the reducer is exhausted, or `maxAttempts` is reached.
 */
export async function runOverflowReductionLoop(
  args: OverflowReduceArgs,
): Promise<OverflowReduceResult> {
  let messages = args.messages;
  let runMessages = args.runMessages;
  let injectionMode: "full" | "minimal" = "full";
  let reducerState: ReducerState = createInitialReducerState();
  let attempts = 0;

  while (attempts < args.maxAttempts && !reducerState.exhausted) {
    // Abort check at the top of every iteration. When the caller aborts
    // externally, this check lets us bail out BETWEEN iterations rather
    // than letting another round of compaction / re-injection mutate
    // `ctx.messages` after the turn has already failed. Individual
    // `reduceContextOverflow` calls also honor the signal, but without this
    // gate a fresh iteration could still start after the signal fires,
    // since the previous one returned normally before the abort propagated.
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

    // Let the orchestrator apply compaction side effects (circuit-breaker
    // tracking, event emission, ctx mutation) before we re-inject.
    if (step.compactionResult) {
      await args.onCompactionResult(step.compactionResult, basisMessages);
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
    runMessages = await args.reinjectForMode(messages, injectionMode);

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
    attempts,
  };
}
