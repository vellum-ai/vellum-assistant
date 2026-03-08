import { z } from "zod";

export const MemoryRerankingConfigSchema = z.object({
  enabled: z
    .boolean({ error: "memory.retrieval.reranking.enabled must be a boolean" })
    .default(false),
  modelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error:
        "memory.retrieval.reranking.modelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
  topK: z
    .number({ error: "memory.retrieval.reranking.topK must be a number" })
    .int("memory.retrieval.reranking.topK must be an integer")
    .positive("memory.retrieval.reranking.topK must be a positive integer")
    .default(20),
});

export const MemoryDynamicBudgetConfigSchema = z.object({
  enabled: z
    .boolean({
      error: "memory.retrieval.dynamicBudget.enabled must be a boolean",
    })
    .default(true),
  minInjectTokens: z
    .number({
      error: "memory.retrieval.dynamicBudget.minInjectTokens must be a number",
    })
    .int("memory.retrieval.dynamicBudget.minInjectTokens must be an integer")
    .positive(
      "memory.retrieval.dynamicBudget.minInjectTokens must be a positive integer",
    )
    .default(1200),
  maxInjectTokens: z
    .number({
      error: "memory.retrieval.dynamicBudget.maxInjectTokens must be a number",
    })
    .int("memory.retrieval.dynamicBudget.maxInjectTokens must be an integer")
    .positive(
      "memory.retrieval.dynamicBudget.maxInjectTokens must be a positive integer",
    )
    .default(10000),
  targetHeadroomTokens: z
    .number({
      error:
        "memory.retrieval.dynamicBudget.targetHeadroomTokens must be a number",
    })
    .int(
      "memory.retrieval.dynamicBudget.targetHeadroomTokens must be an integer",
    )
    .positive(
      "memory.retrieval.dynamicBudget.targetHeadroomTokens must be a positive integer",
    )
    .default(10000),
});

export const MemoryEarlyTerminationConfigSchema = z.object({
  enabled: z
    .boolean({
      error: "memory.retrieval.earlyTermination.enabled must be a boolean",
    })
    .default(true),
  minCandidates: z
    .number({
      error: "memory.retrieval.earlyTermination.minCandidates must be a number",
    })
    .int("memory.retrieval.earlyTermination.minCandidates must be an integer")
    .positive(
      "memory.retrieval.earlyTermination.minCandidates must be a positive integer",
    )
    .default(20),
  minHighConfidence: z
    .number({
      error:
        "memory.retrieval.earlyTermination.minHighConfidence must be a number",
    })
    .int(
      "memory.retrieval.earlyTermination.minHighConfidence must be an integer",
    )
    .positive(
      "memory.retrieval.earlyTermination.minHighConfidence must be a positive integer",
    )
    .default(10),
  confidenceThreshold: z
    .number({
      error:
        "memory.retrieval.earlyTermination.confidenceThreshold must be a number",
    })
    .min(
      0,
      "memory.retrieval.earlyTermination.confidenceThreshold must be >= 0",
    )
    .max(
      1,
      "memory.retrieval.earlyTermination.confidenceThreshold must be <= 1",
    )
    .default(0.7),
});

/**
 * Per-kind freshness windows (in days). Items older than their window
 * (based on lastSeenAt) are down-ranked unless recently reinforced.
 * A value of 0 disables freshness decay for that kind.
 */
const MemoryFreshnessConfigSchema = z.object({
  enabled: z
    .boolean({ error: "memory.retrieval.freshness.enabled must be a boolean" })
    .default(true),
  maxAgeDays: z
    .object({
      fact: z
        .number({
          error: "memory.retrieval.freshness.maxAgeDays.fact must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.fact must be non-negative",
        )
        .default(0),
      preference: z
        .number({
          error:
            "memory.retrieval.freshness.maxAgeDays.preference must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.preference must be non-negative",
        )
        .default(0),
      behavior: z
        .number({
          error:
            "memory.retrieval.freshness.maxAgeDays.behavior must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.behavior must be non-negative",
        )
        .default(90),
      event: z
        .number({
          error: "memory.retrieval.freshness.maxAgeDays.event must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.event must be non-negative",
        )
        .default(30),
      opinion: z
        .number({
          error:
            "memory.retrieval.freshness.maxAgeDays.opinion must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.opinion must be non-negative",
        )
        .default(60),
    })
    .default({ fact: 0, preference: 0, behavior: 90, event: 30, opinion: 60 }),
  staleDecay: z
    .number({ error: "memory.retrieval.freshness.staleDecay must be a number" })
    .min(0, "memory.retrieval.freshness.staleDecay must be >= 0")
    .max(1, "memory.retrieval.freshness.staleDecay must be <= 1")
    .default(0.5),
  reinforcementShieldDays: z
    .number({
      error:
        "memory.retrieval.freshness.reinforcementShieldDays must be a number",
    })
    .nonnegative(
      "memory.retrieval.freshness.reinforcementShieldDays must be non-negative",
    )
    .default(7),
});

export const MemoryRetrievalConfigSchema = z.object({
  lexicalTopK: z
    .number({ error: "memory.retrieval.lexicalTopK must be a number" })
    .int("memory.retrieval.lexicalTopK must be an integer")
    .positive("memory.retrieval.lexicalTopK must be a positive integer")
    .default(80),
  semanticTopK: z
    .number({ error: "memory.retrieval.semanticTopK must be a number" })
    .int("memory.retrieval.semanticTopK must be an integer")
    .positive("memory.retrieval.semanticTopK must be a positive integer")
    .default(40),
  maxInjectTokens: z
    .number({ error: "memory.retrieval.maxInjectTokens must be a number" })
    .int("memory.retrieval.maxInjectTokens must be an integer")
    .positive("memory.retrieval.maxInjectTokens must be a positive integer")
    .default(10000),
  injectionFormat: z
    .enum(["markdown", "structured_v1"], {
      error:
        'memory.retrieval.injectionFormat must be "markdown" or "structured_v1"',
    })
    .default("markdown"),
  injectionStrategy: z
    .enum(["prepend_user_block", "separate_context_message"], {
      error:
        'memory.retrieval.injectionStrategy must be "prepend_user_block" or "separate_context_message"',
    })
    .default("prepend_user_block"),
  reranking: MemoryRerankingConfigSchema.default(
    MemoryRerankingConfigSchema.parse({}),
  ),
  freshness: MemoryFreshnessConfigSchema.default(
    MemoryFreshnessConfigSchema.parse({}),
  ),
  scopePolicy: z
    .enum(["allow_global_fallback", "strict"], {
      error:
        'memory.retrieval.scopePolicy must be "allow_global_fallback" or "strict"',
    })
    .default("allow_global_fallback"),
  dynamicBudget: MemoryDynamicBudgetConfigSchema.default(
    MemoryDynamicBudgetConfigSchema.parse({}),
  ),
  earlyTermination: MemoryEarlyTerminationConfigSchema.default(
    MemoryEarlyTerminationConfigSchema.parse({}),
  ),
});

export type MemoryRerankingConfig = z.infer<typeof MemoryRerankingConfigSchema>;
export type MemoryRetrievalConfig = z.infer<typeof MemoryRetrievalConfigSchema>;
