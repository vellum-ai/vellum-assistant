import { z } from "zod";

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
      identity: z
        .number({
          error:
            "memory.retrieval.freshness.maxAgeDays.identity must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.identity must be non-negative",
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
      project: z
        .number({
          error:
            "memory.retrieval.freshness.maxAgeDays.project must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.project must be non-negative",
        )
        .default(30),
      decision: z
        .number({
          error:
            "memory.retrieval.freshness.maxAgeDays.decision must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.decision must be non-negative",
        )
        .default(30),
      constraint: z
        .number({
          error:
            "memory.retrieval.freshness.maxAgeDays.constraint must be a number",
        })
        .nonnegative(
          "memory.retrieval.freshness.maxAgeDays.constraint must be non-negative",
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
    })
    .default({
      identity: 0,
      preference: 0,
      project: 30,
      decision: 30,
      constraint: 90,
      event: 30,
    }),
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
});

export type MemoryRetrievalConfig = z.infer<typeof MemoryRetrievalConfigSchema>;
