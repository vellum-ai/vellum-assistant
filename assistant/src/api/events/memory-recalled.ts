/**
 * `memory_recalled` SSE event.
 *
 * Server → client debug/telemetry gauge emitted once per turn after the
 * memory subsystem recalls context. Carries the recall provider/model,
 * per-tier hit counts, hybrid-search timing, and the token budget
 * injected into the prompt, plus a `topCandidates` breakdown for
 * debugging ranking. A side gauge, not part of the ordered timeline.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

/** Why semantic recall fell back to a degraded path, if it did. */
export const MemoryRecalledDegradationSchema = z.object({
  semanticUnavailable: z.boolean(),
  reason: z.string(),
  fallbackSources: z.array(z.string()),
});

export type MemoryRecalledDegradation = z.infer<
  typeof MemoryRecalledDegradationSchema
>;

/** Per-candidate scoring breakdown surfaced for recall debugging. */
export const MemoryRecalledCandidateDebugSchema = z.object({
  key: z.string(),
  type: z.string(),
  kind: z.string(),
  finalScore: z.number(),
  semantic: z.number(),
  recency: z.number(),
});

export type MemoryRecalledCandidateDebug = z.infer<
  typeof MemoryRecalledCandidateDebugSchema
>;

export const MemoryRecalledEventSchema = z.object({
  type: z.literal("memory_recalled"),
  provider: z.string(),
  model: z.string(),
  degradation: MemoryRecalledDegradationSchema.optional(),
  semanticHits: z.number(),
  tier1Count: z.number(),
  tier2Count: z.number(),
  hybridSearchLatencyMs: z.number(),
  sparseVectorUsed: z.boolean(),
  mergedCount: z.number(),
  selectedCount: z.number(),
  injectedTokens: z.number(),
  latencyMs: z.number(),
  topCandidates: z.array(MemoryRecalledCandidateDebugSchema),
});

export type MemoryRecalledEvent = z.infer<typeof MemoryRecalledEventSchema>;
