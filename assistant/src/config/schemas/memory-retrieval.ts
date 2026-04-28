import { z } from "zod";

const MemoryDynamicBudgetConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "memory.retrieval.dynamicBudget.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "Whether to dynamically adjust the memory injection budget based on available context space",
      ),
    minInjectTokens: z
      .number({
        error:
          "memory.retrieval.dynamicBudget.minInjectTokens must be a number",
      })
      .int("memory.retrieval.dynamicBudget.minInjectTokens must be an integer")
      .positive(
        "memory.retrieval.dynamicBudget.minInjectTokens must be a positive integer",
      )
      .default(2400)
      .describe(
        "Minimum number of tokens to inject from memory, even when context space is limited",
      ),
    maxInjectTokens: z
      .number({
        error:
          "memory.retrieval.dynamicBudget.maxInjectTokens must be a number",
      })
      .int("memory.retrieval.dynamicBudget.maxInjectTokens must be an integer")
      .positive(
        "memory.retrieval.dynamicBudget.maxInjectTokens must be a positive integer",
      )
      .default(16000)
      .describe(
        "Maximum number of tokens to inject from memory, even when plenty of context space is available",
      ),
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
      .default(10000)
      .describe(
        "Number of tokens to keep free in the context window for new conversation turns",
      ),
  })
  .describe(
    "Dynamically adjusts how many memory tokens are injected based on available context space",
  );

/**
 * Per-kind freshness windows (in days). Items older than their window
 * (based on lastSeenAt) are down-ranked unless recently reinforced.
 * A value of 0 disables freshness decay for that kind.
 */
const MemoryFreshnessConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "memory.retrieval.freshness.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "Whether to apply freshness-based ranking to retrieved memory items",
      ),
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
          .default(0)
          .describe(
            "Days before identity memories are considered stale (0 = never stale)",
          ),
        preference: z
          .number({
            error:
              "memory.retrieval.freshness.maxAgeDays.preference must be a number",
          })
          .nonnegative(
            "memory.retrieval.freshness.maxAgeDays.preference must be non-negative",
          )
          .default(0)
          .describe(
            "Days before preference memories are considered stale (0 = never stale)",
          ),
        project: z
          .number({
            error:
              "memory.retrieval.freshness.maxAgeDays.project must be a number",
          })
          .nonnegative(
            "memory.retrieval.freshness.maxAgeDays.project must be non-negative",
          )
          .default(30)
          .describe(
            "Days before project memories are considered stale (0 = never stale)",
          ),
        decision: z
          .number({
            error:
              "memory.retrieval.freshness.maxAgeDays.decision must be a number",
          })
          .nonnegative(
            "memory.retrieval.freshness.maxAgeDays.decision must be non-negative",
          )
          .default(30)
          .describe(
            "Days before decision memories are considered stale (0 = never stale)",
          ),
        constraint: z
          .number({
            error:
              "memory.retrieval.freshness.maxAgeDays.constraint must be a number",
          })
          .nonnegative(
            "memory.retrieval.freshness.maxAgeDays.constraint must be non-negative",
          )
          .default(90)
          .describe(
            "Days before constraint memories are considered stale (0 = never stale)",
          ),
        event: z
          .number({
            error:
              "memory.retrieval.freshness.maxAgeDays.event must be a number",
          })
          .nonnegative(
            "memory.retrieval.freshness.maxAgeDays.event must be non-negative",
          )
          .default(30)
          .describe(
            "Days before event memories are considered stale (0 = never stale)",
          ),
      })
      .default({
        identity: 0,
        preference: 0,
        project: 30,
        decision: 30,
        constraint: 90,
        event: 30,
      })
      .describe(
        "Per-kind freshness windows in days — items older than their window are down-ranked",
      ),
    staleDecay: z
      .number({
        error: "memory.retrieval.freshness.staleDecay must be a number",
      })
      .min(0, "memory.retrieval.freshness.staleDecay must be >= 0")
      .max(1, "memory.retrieval.freshness.staleDecay must be <= 1")
      .default(0.5)
      .describe(
        "Score multiplier applied to stale memory items (0 = fully suppress, 1 = no decay)",
      ),
    reinforcementShieldDays: z
      .number({
        error:
          "memory.retrieval.freshness.reinforcementShieldDays must be a number",
      })
      .nonnegative(
        "memory.retrieval.freshness.reinforcementShieldDays must be non-negative",
      )
      .default(7)
      .describe(
        "Days after reinforcement during which a memory item is protected from freshness decay",
      ),
  })
  .describe(
    "Freshness-based ranking for memory retrieval — down-ranks old items unless recently reinforced",
  );

const MemoryContextLoadInjectionSchema = z
  .object({
    maxNodes: z
      .number({
        error:
          "memory.retrieval.injection.contextLoad.maxNodes must be a number",
      })
      .int("memory.retrieval.injection.contextLoad.maxNodes must be an integer")
      .positive(
        "memory.retrieval.injection.contextLoad.maxNodes must be a positive integer",
      )
      .default(25)
      .describe("Maximum number of memory nodes to load at conversation start"),
    serendipitySlots: z
      .number({
        error:
          "memory.retrieval.injection.contextLoad.serendipitySlots must be a number",
      })
      .int(
        "memory.retrieval.injection.contextLoad.serendipitySlots must be an integer",
      )
      .nonnegative(
        "memory.retrieval.injection.contextLoad.serendipitySlots must be non-negative",
      )
      .default(5)
      .describe("Number of random wildcard memory picks at conversation start"),
    capabilityReserve: z
      .number({
        error:
          "memory.retrieval.injection.contextLoad.capabilityReserve must be a number",
      })
      .int(
        "memory.retrieval.injection.contextLoad.capabilityReserve must be an integer",
      )
      .nonnegative(
        "memory.retrieval.injection.contextLoad.capabilityReserve must be non-negative",
      )
      .default(5)
      .describe(
        "Reserved slots for skill/CLI capability nodes at conversation start",
      ),
  })
  .describe("Memory injection limits at conversation start");

const MemoryPerTurnInjectionSchema = z
  .object({
    maxNodes: z
      .number({
        error: "memory.retrieval.injection.perTurn.maxNodes must be a number",
      })
      .int("memory.retrieval.injection.perTurn.maxNodes must be an integer")
      .positive(
        "memory.retrieval.injection.perTurn.maxNodes must be a positive integer",
      )
      .default(6)
      .describe(
        "Maximum total memory nodes injected per turn (general + capability + serendipity)",
      ),
    serendipitySlots: z
      .number({
        error:
          "memory.retrieval.injection.perTurn.serendipitySlots must be a number",
      })
      .int(
        "memory.retrieval.injection.perTurn.serendipitySlots must be an integer",
      )
      .nonnegative(
        "memory.retrieval.injection.perTurn.serendipitySlots must be non-negative",
      )
      .default(1)
      .describe("Number of random wildcard memory picks per turn"),
    capabilityReserve: z
      .number({
        error:
          "memory.retrieval.injection.perTurn.capabilityReserve must be a number",
      })
      .int(
        "memory.retrieval.injection.perTurn.capabilityReserve must be an integer",
      )
      .nonnegative(
        "memory.retrieval.injection.perTurn.capabilityReserve must be non-negative",
      )
      .default(2)
      .describe("Reserved slots for skill/CLI capability nodes per turn"),
  })
  .describe("Memory injection limits for mid-conversation turns");

const MemoryInjectionConfigSchema = z
  .object({
    contextLoad: MemoryContextLoadInjectionSchema.default(
      MemoryContextLoadInjectionSchema.parse({}),
    ),
    perTurn: MemoryPerTurnInjectionSchema.default(
      MemoryPerTurnInjectionSchema.parse({}),
    ),
  })
  .describe(
    "Controls how many memory items are injected at conversation start and per turn",
  );

export const MemoryRetrievalConfigSchema = z
  .object({
    maxInjectTokens: z
      .number({ error: "memory.retrieval.maxInjectTokens must be a number" })
      .int("memory.retrieval.maxInjectTokens must be an integer")
      .positive("memory.retrieval.maxInjectTokens must be a positive integer")
      .default(16000)
      .describe(
        "Maximum number of tokens to inject from long-term memory into the conversation context",
      ),
    freshness: MemoryFreshnessConfigSchema.default(
      MemoryFreshnessConfigSchema.parse({}),
    ),
    scopePolicy: z
      .enum(["allow_global_fallback", "strict"], {
        error:
          'memory.retrieval.scopePolicy must be "allow_global_fallback" or "strict"',
      })
      .default("allow_global_fallback")
      .describe(
        "Whether to fall back to global memories when scoped results are insufficient, or strictly scope results",
      ),
    dynamicBudget: MemoryDynamicBudgetConfigSchema.default(
      MemoryDynamicBudgetConfigSchema.parse({}),
    ),
    injection: MemoryInjectionConfigSchema.default(
      MemoryInjectionConfigSchema.parse({}),
    ),
  })
  .describe(
    "Controls how memories are retrieved and injected into conversations",
  );

export type MemoryRetrievalConfig = z.infer<typeof MemoryRetrievalConfigSchema>;
