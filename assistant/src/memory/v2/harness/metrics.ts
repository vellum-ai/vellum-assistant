/**
 * Recall@k and per-lane diff for the comparison harness.
 *
 * Ground truth is the current router's logged selections (see `oracle.ts`). A
 * retriever's "extras" (selected, not in ground truth) are reported as a
 * *diff*, not an error — a better retriever may legitimately surface pages the
 * router missed. recall@k is the primary signal.
 */

import type { RetrievalOutput } from "./retriever.js";

export interface TurnEval {
  groundTruth: string[];
  selected: string[];
  /** Ground-truth slugs the retriever selected (anywhere in its output). */
  hits: string[];
  /** Ground-truth slugs the retriever missed entirely. */
  misses: string[];
  /** Selected slugs not in ground truth — diff, not error. */
  extras: string[];
  /** recall@k for each requested k. */
  recallAtK: Record<number, number>;
  /** Counts of hits grouped by the retriever's source/lane labels. */
  hitsByLane: Record<string, number>;
  costUsd?: number;
  failureReason: string | null;
}

export interface AggregateEval {
  turns: number;
  meanRecallAtK: Record<number, number>;
  failureRate: number;
  meanCostUsd?: number;
}

/**
 * recall@k = |topK(selected) ∩ G| / |G|. An empty ground-truth set is defined
 * as recall 1 (nothing to recall — vacuously complete).
 *
 * The top-k window is deduped before intersecting with the ground-truth set so
 * a retriever that emits the same slug twice (e.g. `['a','a']`) cannot count it
 * twice and push recall above 1.0. Recall is therefore bounded in [0, 1].
 */
export function recallAtK(
  selected: readonly string[],
  groundTruth: ReadonlySet<string>,
  k: number,
): number {
  if (groundTruth.size === 0) return 1;
  let hit = 0;
  for (const slug of new Set(selected.slice(0, k))) {
    if (groundTruth.has(slug)) hit++;
  }
  return hit / groundTruth.size;
}

export function evalTurn(
  output: RetrievalOutput,
  groundTruth: readonly string[],
  ks: readonly number[],
): TurnEval {
  const gtList = Array.from(new Set(groundTruth));
  const gtSet = new Set(gtList);
  const selectedSet = new Set(output.selectedSlugs);

  const hits: string[] = [];
  const misses: string[] = [];
  for (const slug of gtList) {
    (selectedSet.has(slug) ? hits : misses).push(slug);
  }
  const extras = output.selectedSlugs.filter((s) => !gtSet.has(s));

  const recall: Record<number, number> = {};
  for (const k of ks) {
    recall[k] = recallAtK(output.selectedSlugs, gtSet, k);
  }

  const hitsByLane: Record<string, number> = {};
  for (const slug of hits) {
    const lane = output.sourceBySlug.get(slug) ?? "unknown";
    hitsByLane[lane] = (hitsByLane[lane] ?? 0) + 1;
  }

  return {
    groundTruth: gtList,
    selected: output.selectedSlugs,
    hits,
    misses,
    extras,
    recallAtK: recall,
    hitsByLane,
    ...(output.cost?.usd !== undefined ? { costUsd: output.cost.usd } : {}),
    failureReason: output.failureReason ?? null,
  };
}

export function aggregate(
  perTurn: readonly TurnEval[],
  ks: readonly number[],
): AggregateEval {
  const turns = perTurn.length;

  const meanRecallAtK: Record<number, number> = {};
  for (const k of ks) {
    if (turns === 0) {
      meanRecallAtK[k] = 0;
      continue;
    }
    let sum = 0;
    for (const t of perTurn) sum += t.recallAtK[k] ?? 0;
    meanRecallAtK[k] = sum / turns;
  }

  const failures = perTurn.filter((t) => t.failureReason != null).length;
  const costed = perTurn.filter((t) => t.costUsd !== undefined);

  return {
    turns,
    meanRecallAtK,
    failureRate: turns === 0 ? 0 : failures / turns,
    ...(costed.length > 0
      ? {
          meanCostUsd:
            costed.reduce((s, t) => s + (t.costUsd ?? 0), 0) / costed.length,
        }
      : {}),
  };
}
