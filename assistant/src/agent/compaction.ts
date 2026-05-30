/**
 * Compaction pipeline invocation helper.
 *
 * Single chokepoint for every call into the `"compaction"` plugin pipeline
 * inside the agent loop. Before this module, four sites in
 * `daemon/conversation-agent-loop.ts` each constructed the same
 * `runPipeline → defaultCompactionTerminal → PluginTimeoutError catch →
 * trackCompactionOutcome` boilerplate independently:
 *
 *   1. start-of-turn compaction
 *   2. mid-loop compaction (post-checkpoint yield)
 *   3. overflow reducer's `forced_compaction` tier
 *   4. emergency `auto_compress_latest_turn` rerun
 *
 * Each site varied only in two ways: the `phase` label used for log
 * attribution, and what to do on a `PluginTimeoutError` (skip / fall
 * through / escalate / final-fail). Consolidating the shared shape here
 * means future Compaction Re-homing Arc bullets — moving the trigger into
 * `agent/loop.ts` and re-homing the modules under the default plugin —
 * have ONE place to touch instead of four.
 *
 * Design notes:
 *
 *   - This is a thin orchestration helper, not a behavior change. The
 *     output of {@link defaultCompactionTerminal} is returned verbatim on
 *     the happy path. Site-specific timeout fallbacks (e.g. the reducer
 *     wanting to keep iterating to the next tier; the orchestrator
 *     wanting to break the mid-loop while-block) remain at the call site
 *     in a `if (!outcome.ok) { ... }` branch.
 *   - We bubble every error other than `PluginTimeoutError` so plugin
 *     execution failures still surface to the orchestrator's normal
 *     error path.
 *   - The helper does NOT mutate `ctx`. It calls
 *     {@link trackCompactionOutcome} on the timeout branch (the existing
 *     contract), but never reads/writes turn state otherwise.
 *
 * See the Compaction Visibility workstream → Compaction Re-homing Arc,
 * Bullet 2.
 */

import type pino from "pino";

import type { ContextWindowCompactOptions } from "../context/window-manager.js";
import {
  type AgentLoopConversationContext,
  buildPluginTurnContext,
  trackCompactionOutcome,
} from "../daemon/conversation-agent-loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { defaultCompactionTerminal } from "../plugins/defaults/compaction.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import { getMiddlewaresFor } from "../plugins/registry.js";
import {
  type CompactionArgs,
  type CompactionResult,
  PluginTimeoutError,
} from "../plugins/types.js";
import type { Message } from "../providers/types.js";

/** Phase tag for log attribution. */
export type CompactionPipelinePhase =
  | "start-of-turn-compaction"
  | "overflow-reducer-forced-compaction"
  | "mid-loop-compact"
  | "emergency-compaction";

/**
 * Result returned by `defaultCompactionTerminal`. Declared as the same
 * `Awaited<ReturnType<...>>` shape every caller previously cast to, so
 * the migration is a 1:1 swap.
 */
export type CompactionPipelineOk = Awaited<
  ReturnType<
    AgentLoopConversationContext["contextWindowManager"]["maybeCompact"]
  >
>;

/**
 * Discriminated outcome. The orchestrator branches on `ok` to decide
 * whether to consume the compaction result or invoke its site-specific
 * timeout fallback.
 */
export type CompactionPipelineOutcome =
  | { readonly ok: true; readonly result: CompactionPipelineOk }
  | {
      readonly ok: false;
      readonly reason: "timeout";
      readonly error: PluginTimeoutError;
    };

export interface InvokeCompactionPipelineArgs {
  /** Agent loop conversation context. Used to build the turn context and to record the circuit-breaker outcome on timeout. */
  readonly ctx: AgentLoopConversationContext;
  /** Per-turn request id used for log + trace correlation. */
  readonly requestId: string;
  /** Phase tag used in the timeout warning and in the future to attribute logs. */
  readonly phase: CompactionPipelinePhase;
  /** Messages handed to the compaction pipeline. Caller decides whether this is `ctx.messages`, the start-of-turn snapshot, or a reducer-supplied subset. */
  readonly messages: Message[];
  /** Abort signal that aborts the pipeline (and its inner summary call). */
  readonly signal: AbortSignal;
  /** Compaction options forwarded to the default terminal. */
  readonly options: ContextWindowCompactOptions;
  /** Event sink for `trackCompactionOutcome` to surface circuit-breaker state when the pipeline times out. */
  readonly onEvent: (msg: ServerMessage) => void;
  /** Caller-supplied logger. The helper logs ONLY the timeout warning; per-site verbose logs (e.g. "running compaction after checkpoint yield") stay at the call site. */
  readonly logger: pino.Logger;
  /**
   * Pipeline timeout in ms. Optional — defaults to
   * `DEFAULT_TIMEOUTS.compaction`. Tests override this to keep run time
   * tight; production never sets it.
   */
  readonly timeoutMs?: number;
}

/**
 * Invoke the `compaction` plugin pipeline once. Wraps `runPipeline` with
 * the shared catch-and-degrade behavior every existing call site
 * duplicated.
 *
 * Returns `{ ok: true, result }` with the terminal's output on success,
 * and `{ ok: false, reason: "timeout", error }` when the pipeline
 * exceeds its budget. All other errors bubble — caller's responsibility.
 *
 * Side effect on timeout: calls `trackCompactionOutcome(ctx, true, onEvent)`
 * so the circuit breaker counts the failure consistently with the prior
 * per-site code paths.
 */
export async function invokeCompactionPipeline(
  args: InvokeCompactionPipelineArgs,
): Promise<CompactionPipelineOutcome> {
  const {
    ctx,
    requestId,
    phase,
    messages,
    signal,
    options,
    onEvent,
    logger,
    timeoutMs = DEFAULT_TIMEOUTS.compaction,
  } = args;

  try {
    const result = (await runPipeline<CompactionArgs, CompactionResult>(
      "compaction",
      getMiddlewaresFor("compaction"),
      (pipelineArgs) =>
        defaultCompactionTerminal(
          pipelineArgs,
          buildPluginTurnContext(ctx, requestId),
        ),
      {
        messages,
        signal,
        options,
      },
      buildPluginTurnContext(ctx, requestId),
      timeoutMs,
    )) as CompactionPipelineOk;
    return { ok: true, result };
  } catch (err) {
    if (err instanceof PluginTimeoutError) {
      logger.warn({ err, phase }, "Compaction pipeline timed out");
      await trackCompactionOutcome(ctx, true, onEvent);
      return { ok: false, reason: "timeout", error: err };
    }
    throw err;
  }
}
