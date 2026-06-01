/**
 * Terminal handler for the default `historyRepair` pipeline.
 *
 * This module is side-effect free: importing it does not register any plugin.
 * The terminal is wired in as the pipeline's `terminal` argument by the
 * `runPipeline` call site in `daemon/conversation-agent-loop.ts`.
 *
 * Scope: this pipeline wraps only the standard pre-run repair (`repairHistory`).
 * The orchestrator's one-shot deep-repair fallback (`deepRepairHistory`),
 * invoked only after a provider ordering error, intentionally bypasses the
 * pipeline today — see the design note at the `deepRepairHistory` call site
 * in `daemon/conversation-agent-loop.ts`.
 */

import { repairHistory } from "../../../daemon/history-repair.js";
import type { HistoryRepairArgs, HistoryRepairResult } from "../../types.js";

/**
 * Terminal handler for the `historyRepair` pipeline. Exported so tests can
 * verify default behavior directly without going through `runPipeline`, and
 * so `daemon/conversation-agent-loop.ts` can pass it as the `terminal`
 * argument to `runPipeline`.
 */
export function defaultHistoryRepairTerminal(
  args: HistoryRepairArgs,
): HistoryRepairResult {
  return repairHistory(args.history);
}
