/**
 * Comparison runner — execute N retrievers over a set of oracle turns and score
 * each against ground truth.
 *
 * The runner is DB/workspace-agnostic: input reconstruction is injected as a
 * function, so it can be unit-tested with stubs and the route/CLI can wire in
 * the real `reconstructInput` (which needs a DB + workspace).
 */

import {
  aggregate,
  type AggregateEval,
  evalTurn,
  type TurnEval,
} from "./metrics.js";
import type { OracleTurn } from "./oracle.js";
import type { ReconstructedInput } from "./replay-input.js";
import type { Retriever } from "./retriever.js";

export interface ComparisonTurnResult {
  conversationId: string;
  turn: number;
  /** Per-retriever evaluation for this turn, keyed by retriever name. */
  byRetriever: Record<string, TurnEval>;
}

export interface RetrieverReport {
  name: string;
  aggregate: AggregateEval;
}

export interface ComparisonReport {
  ks: number[];
  /** Oracle turns handed to the runner. */
  turnsConsidered: number;
  /** Turns actually scored (reconstruction succeeded). */
  turnsScored: number;
  /** Turns skipped because input reconstruction returned null. */
  turnsSkipped: number;
  perTurn: ComparisonTurnResult[];
  retrievers: RetrieverReport[];
}

export interface RunComparisonParams {
  retrievers: readonly Retriever[];
  oracleTurns: readonly OracleTurn[];
  /** Reconstruct a turn's retriever input; return null to skip the turn. */
  reconstruct: (turn: OracleTurn) => Promise<ReconstructedInput | null>;
  ks: readonly number[];
  signal?: AbortSignal;
}

export async function runComparison(
  params: RunComparisonParams,
): Promise<ComparisonReport> {
  const { retrievers, oracleTurns, reconstruct, ks, signal } = params;

  const perTurn: ComparisonTurnResult[] = [];
  const perRetrieverEvals = new Map<string, TurnEval[]>();
  for (const retriever of retrievers) {
    perRetrieverEvals.set(retriever.name, []);
  }

  let turnsScored = 0;
  let turnsSkipped = 0;

  for (const turn of oracleTurns) {
    if (signal?.aborted) break;

    const reconstructed = await reconstruct(turn);
    if (!reconstructed) {
      turnsSkipped++;
      continue;
    }
    turnsScored++;

    // Thread the abort signal into the reconstructed input so retrievers that
    // wrap LLM calls (e.g. the router retriever forwarding to `runRouter`) abort
    // the in-flight per-turn call on caller disconnect — the loop gating below
    // only stops scheduling new work, it can't cancel the current retrieval.
    if (signal) reconstructed.input.signal = signal;

    const byRetriever: Record<string, TurnEval> = {};
    for (const retriever of retrievers) {
      if (signal?.aborted) break;
      const output = await retriever.retrieve(reconstructed.input);
      const turnEval = evalTurn(output, turn.groundTruthSlugs, ks);
      byRetriever[retriever.name] = turnEval;
      perRetrieverEvals.get(retriever.name)?.push(turnEval);
    }

    perTurn.push({
      conversationId: turn.conversationId,
      turn: turn.turn,
      byRetriever,
    });
  }

  const retrieverReports: RetrieverReport[] = retrievers.map((retriever) => ({
    name: retriever.name,
    aggregate: aggregate(perRetrieverEvals.get(retriever.name) ?? [], ks),
  }));

  return {
    ks: [...ks],
    turnsConsidered: oracleTurns.length,
    turnsScored,
    turnsSkipped,
    perTurn,
    retrievers: retrieverReports,
  };
}
