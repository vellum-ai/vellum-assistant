/**
 * Descent-trace schema for a tree-walking retriever.
 *
 * Defined ahead of its producer: the comparison harness renders this and a
 * tree-walking retriever emits it; a tier-based retriever (no tree walk) leaves
 * `RetrievalOutput.trace` undefined. Per level it records which branches were
 * considered, descended, and skipped plus the model's reasoning, so a wrong
 * high-level skip is observable rather than silent.
 */

import type { RetrievalCost } from "./retriever.js";

/** A scout lane's contribution on one pass. */
export interface ScoutResult {
  lane: "hot" | "sparse" | "dense";
  slugs: string[];
  /** Optional per-slug score (BM25 / cosine / EMA) for inspection. */
  scoreBySlug?: Record<string, number>;
}

/** One level of the tree walk: what was considered, descended, and skipped. */
export interface TreeLevel {
  /** Node whose index page was read ("" for root, else a branch path). */
  node: string;
  considered: string[];
  descended: string[];
  skipped: string[];
  /** The model's stated reason for the descend/skip split at this node. */
  reasoning: string;
  cost?: RetrievalCost;
}

/** A 1–2 hop walk along the curated `edges:` graph from a seed page. */
export interface EdgeExpansion {
  from: string;
  pulled: string[];
}

/** The gate's decision at the end of a pass. */
export interface GateDecision {
  decision: "ready" | "more";
  /** When "more", the generated follow-up queries seeding the next pass. */
  questions?: string[];
  /**
   * The gate's one-line rationale for this verdict, when it supplied one.
   * Surfaced in the descent trace and the live-shadow telemetry so a run can be
   * analyzed after the fact ("why did the gate keep this set?").
   */
  reasoning?: string;
}

/** Everything that happened on one pass of the loop. */
export interface DescentPass {
  passNumber: number;
  scouts?: ScoutResult[];
  treeLevels?: TreeLevel[];
  edgeExpansions?: EdgeExpansion[];
  gate?: GateDecision;
}

/** A full loop execution, pass by pass. */
export interface DescentTrace {
  passes: DescentPass[];
}
