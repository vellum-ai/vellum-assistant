import {
  type RecallDepth,
  RecallDepthSchema,
  type RecallSource,
  RecallSourceSchema,
} from "../../../../api/events/tool-result.js";
import type { RecallInput } from "./recall-input.js";

export const DEFAULT_RECALL_MAX_RESULTS = 8;
export const MIN_RECALL_MAX_RESULTS = 1;
export const MAX_RECALL_MAX_RESULTS = 20;

const DEFAULT_RECALL_DEPTH: RecallDepth = "standard";

export const RECALL_SOURCE_ROUNDS_BY_DEPTH: Record<RecallDepth, number> = {
  fast: 1,
  standard: 2,
  deep: 3,
};

export const RECALL_EVIDENCE_TEXT_CAP_PER_SOURCE = 6_000;
export const RECALL_TOTAL_EVIDENCE_TEXT_CAP = 18_000;

export interface NormalizedRecallInput {
  query: string;
  sources: RecallSource[];
  maxResults: number;
  depth: RecallDepth;
  sourceRounds: number;
}

export function normalizeRecallInput(
  input: RecallInput,
): NormalizedRecallInput {
  const depth = normalizeRecallDepth(input.depth);

  return {
    query: input.query,
    sources: normalizeRecallSources(input.sources),
    maxResults: normalizeRecallMaxResults(input.max_results),
    depth,
    sourceRounds: RECALL_SOURCE_ROUNDS_BY_DEPTH[depth],
  };
}

export function normalizeRecallSources(
  sources: readonly RecallSource[] | undefined,
): RecallSource[] {
  if (!sources || sources.length === 0) {
    return [...RecallSourceSchema.options];
  }

  const normalized: RecallSource[] = [];
  for (const source of sources) {
    if (!isRecallSource(source)) {
      throw new Error(`Unknown recall source: ${String(source)}`);
    }
    if (!normalized.includes(source)) {
      normalized.push(source);
    }
  }

  return normalized;
}

export function normalizeRecallMaxResults(
  maxResults: number | undefined,
): number {
  if (typeof maxResults !== "number" || !Number.isFinite(maxResults)) {
    return DEFAULT_RECALL_MAX_RESULTS;
  }

  const integerMaxResults = Math.floor(maxResults);
  return clamp(
    integerMaxResults,
    MIN_RECALL_MAX_RESULTS,
    MAX_RECALL_MAX_RESULTS,
  );
}

function normalizeRecallDepth(depth: RecallDepth | undefined): RecallDepth {
  if (depth === undefined) {
    return DEFAULT_RECALL_DEPTH;
  }

  if (!RecallDepthSchema.safeParse(depth).success) {
    throw new Error(`Unknown recall depth: ${String(depth)}`);
  }

  return depth;
}

export function isRecallSource(source: unknown): source is RecallSource {
  return RecallSourceSchema.safeParse(source).success;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
