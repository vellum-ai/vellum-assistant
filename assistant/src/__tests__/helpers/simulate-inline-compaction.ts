import { CompactionCircuit } from "../../agent/compaction-circuit.js";
import type { AgentEvent, MidLoopCompaction } from "../../agent/loop.js";
import type { ContextWindowResult } from "../../context/window-manager.js";
import { stripInjectionsForCompaction } from "../../daemon/conversation-runtime-assembly.js";
import { defaultCompactionTerminal } from "../../plugins/defaults/compaction/terminal.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../../plugins/pipeline.js";
import { getMiddlewaresFor } from "../../plugins/registry.js";
import type {
  CompactionArgs,
  CompactionResult,
  TurnContext,
} from "../../plugins/types.js";
import { PluginTimeoutError } from "../../plugins/types.js";
import type { Message } from "../../providers/types.js";

/**
 * Faithful re-implementation of `AgentLoop.compact()` for the mock loop the
 * orchestrator suites drive: run the compaction pipeline against the supplied
 * turn context (which carries the test's `contextWindowManager`), invoke the
 * orchestrator-supplied hook, and return the continuation history — or `null`
 * on timeout/exhaustion so the caller yields "budget".
 *
 * Shared by the orchestrator suites that exercise inline compaction so the
 * mock loop's compaction path stays in one place as the hook's input grows.
 */
export async function simulateInlineCompaction(
  compaction: MidLoopCompaction,
  history: Message[],
  turnContext: TurnContext | undefined,
  signal: AbortSignal | undefined,
  onEvent: (event: AgentEvent) => void | Promise<void>,
  compactionCircuit: CompactionCircuit,
  overrideProfile: string | null,
): Promise<Message[] | null> {
  await onEvent({ type: "context_compacting" });
  // The agent loop strips runtime injections (identity-stubbed in this suite),
  // records the history-stripped marker via `history_stripped`, then owns the
  // forced-compaction decision for its mid-loop budget gate: it sets `force`,
  // the turn actor's trust class, and the resolved inference-profile override
  // directly on the options bag before invoking the pipeline.
  const rawHistory = stripInjectionsForCompaction(history);
  await onEvent({ type: "history_stripped" });
  let result: CompactionResult;
  try {
    result = await runPipeline<CompactionArgs, CompactionResult>(
      "compaction",
      getMiddlewaresFor("compaction"),
      (args) => defaultCompactionTerminal(args, turnContext as TurnContext),
      {
        messages: rawHistory,
        signal,
        options: {
          force: true,
          actorTrustClass: turnContext?.trust.trustClass,
          overrideProfile,
        },
      },
      turnContext as TurnContext,
      DEFAULT_TIMEOUTS.compaction,
    );
  } catch (error) {
    if (error instanceof PluginTimeoutError) {
      await compactionCircuit.recordOutcome(
        {
          currentRequestId: turnContext?.requestId,
          currentTurnTrustContext: turnContext?.trust,
          turnCount: turnContext?.turnIndex ?? 0,
        },
        true,
        onEvent,
      );
      return null;
    }
    throw error;
  }
  const compactResult = result as ContextWindowResult;
  if (compactResult.summaryFailed !== undefined) {
    await compactionCircuit.recordOutcome(
      {
        currentRequestId: turnContext?.requestId,
        currentTurnTrustContext: turnContext?.trust,
        turnCount: turnContext?.turnIndex ?? 0,
      },
      compactResult.summaryFailed,
      onEvent,
    );
  }
  await onEvent({
    type: "compaction_completed",
    result: compactResult,
    basis: rawHistory,
  });
  if (compactResult.exhausted ?? false) {
    return null;
  }
  return compaction.postCompactionHook({
    history: compactResult.compacted ? compactResult.messages : rawHistory,
    turnContext: turnContext as TurnContext,
  });
}
