/**
 * Wire contract for the memory-recall log surfaced in the inspector's
 * Memory tab. Mirrors `MemoryRecallLog` from
 * `assistant/src/memory/memory-recall-log-store.ts`.
 *
 * Canonical wire-contract source. Assistant code imports the types
 * directly from this file via relative paths; external consumers
 * (web client, gateway, evals) import via `@vellumai/assistant-api`.
 *
 * Returned as part of `LlmContextResponse` — see
 * `./llm-context-response.ts`.
 */

import { z } from "zod";

/**
 * A single recalled memory candidate, normalized by the daemon from
 * the SSE-event format into inspector format.
 */
export const MemoryCandidateSchema = z.object({
  nodeId: z.string(),
  score: z.number(),
  semanticSimilarity: z.number(),
  recencyBoost: z.number(),
  type: z.string().optional(),
});

export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/**
 * Degradation details when memory recall ran in a degraded mode.
 */
export const MemoryDegradationSchema = z.object({
  reason: z.string(),
  semanticUnavailable: z.boolean(),
  fallbackSources: z.array(z.string()),
});

export type MemoryDegradation = z.infer<typeof MemoryDegradationSchema>;

/**
 * Memory recall log shape.
 */
export const MemoryRecallLogSchema = z.object({
  enabled: z.boolean(),
  degraded: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  degradation: MemoryDegradationSchema.nullable(),
  semanticHits: z.number().nullish(),
  mergedCount: z.number().nullish(),
  selectedCount: z.number().nullish(),
  tier1Count: z.number().nullish(),
  tier2Count: z.number().nullish(),
  hybridSearchLatencyMs: z.number().nullish(),
  sparseVectorUsed: z.boolean().nullish(),
  injectedTokens: z.number().nullish(),
  latencyMs: z.number().nullish(),
  topCandidates: z.array(MemoryCandidateSchema),
  injectedText: z.string().nullable(),
  reason: z.string().nullable(),
  queryContext: z.string().nullable(),
});

export type MemoryRecallLog = z.infer<typeof MemoryRecallLogSchema>;
