/**
 * The retriever seam for the memory comparison harness.
 *
 * A `Retriever` maps one turn's reconstructed context to a set of selected
 * concept-page slugs. Multiple strategies (the production router, an
 * alternative retrieval loop) implement this single interface, so the harness
 * can run them over the same turns and diff their selections against the oracle
 * (see `oracle.ts`). Offline only — nothing here runs in the live injection
 * path.
 */

import type { AssistantConfig } from "../../../../../config/types.js";
import type { RouterTurnPair } from "../router.js";
import type { EverInjectedEntry } from "../types.js";
import type { DescentTrace } from "./trace.js";

/**
 * Per-turn context a retriever needs, mirroring the live router's inputs
 * (`RunRouterParams`). Reconstructed from historical telemetry by
 * `reconstructInput` (see `replay-input.ts`).
 */
export interface RetrievalInput {
  workspaceDir: string;
  /**
   * Recent (assistant, user) pairs, oldest first. The last entry's
   * `userMessage` is the just-arrived turn being routed.
   */
  recentTurnPairs: readonly RouterTurnPair[];
  /** NOW context (essentials/threads/recent), verbatim. */
  nowText: string;
  /** Slugs already injected on prior turns. */
  priorEverInjected: readonly EverInjectedEntry[];
  config: AssistantConfig;
  signal?: AbortSignal;
}

/** Optional cost accounting for a single retrieval. */
export interface RetrievalCost {
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  ms?: number;
}

/** What a retriever returns for one turn. */
export interface RetrievalOutput {
  /** Selected page slugs, in the retriever's own ranked order. */
  selectedSlugs: string[];
  /**
   * Per-slug provenance / lane label, retriever-defined — router tiers
   * (`tier1`, `tier3:0`, …) for the current router, or loop lanes (`sparse`,
   * `dense`, `tree`, `edge`) for the future loop. Drives per-lane attribution
   * in `metrics.ts`.
   */
  sourceBySlug: ReadonlyMap<string, string>;
  /**
   * Loop-only descent trace. Tier-based retrievers (the current router) have
   * no tree walk and leave this `undefined`; renderers show "(no descent
   * trace)".
   */
  trace?: DescentTrace;
  cost?: RetrievalCost;
  /** Non-null when the retriever could not produce a usable selection. */
  failureReason?: string | null;
}

/**
 * A named retrieval strategy. Implementations must not mutate production state
 * — the harness runs them offline over historical turns.
 */
export interface Retriever {
  readonly name: string;
  retrieve(input: RetrievalInput): Promise<RetrievalOutput>;
}
