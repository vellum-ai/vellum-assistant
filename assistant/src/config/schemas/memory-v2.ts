import { z } from "zod";

/**
 * Tolerance for floating-point comparisons of weight sums. Using 0.001 lets
 * users specify weights to three decimal places without spurious rejections,
 * while still catching obvious mis-sums.
 */
const WEIGHT_SUM_TOLERANCE = 0.001;

/**
 * Memory v2 (concept-page activation model) configuration.
 *
 * Activation weights (`d`, `c_user`, `c_assistant`, `c_now`) must sum to 1.0
 * because they form a convex combination in the per-turn activation formula:
 *   A_o = d·prev + c_user·sim_u + c_assistant·sim_a + c_now·sim_n
 *
 * Hybrid retrieval weights (`dense_weight`, `sparse_weight`) must likewise
 * sum to 1.0 since they fuse normalized dense and sparse similarity scores.
 */
export const MemoryV2ConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "memory.v2.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether the v2 memory subsystem (concept-page activation model) is enabled. Independent of the memory-v2-enabled feature flag — both must be true for v2 to run.",
      ),
    d: z
      .number({ error: "memory.v2.d must be a number" })
      .min(0, "memory.v2.d must be >= 0")
      .max(1, "memory.v2.d must be <= 1")
      .default(0.3)
      .describe(
        "Decay weight on prior activation in the per-turn activation formula",
      ),
    c_user: z
      .number({ error: "memory.v2.c_user must be a number" })
      .min(0, "memory.v2.c_user must be >= 0")
      .max(1, "memory.v2.c_user must be <= 1")
      .default(0.3)
      .describe(
        "Weight on similarity to the latest user message in the per-turn activation formula",
      ),
    c_assistant: z
      .number({ error: "memory.v2.c_assistant must be a number" })
      .min(0, "memory.v2.c_assistant must be >= 0")
      .max(1, "memory.v2.c_assistant must be <= 1")
      .default(0.2)
      .describe(
        "Weight on similarity to the latest assistant message in the per-turn activation formula",
      ),
    c_now: z
      .number({ error: "memory.v2.c_now must be a number" })
      .min(0, "memory.v2.c_now must be >= 0")
      .max(1, "memory.v2.c_now must be <= 1")
      .default(0.2)
      .describe(
        "Weight on similarity to NOW context (essentials/threads/recent) in the per-turn activation formula",
      ),
    k: z
      .number({ error: "memory.v2.k must be a number" })
      .min(0, "memory.v2.k must be >= 0")
      .max(1, "memory.v2.k must be <= 1")
      .default(0.5)
      .describe(
        "Spreading-activation propagation coefficient — fraction of own activation that flows to neighbors per hop",
      ),
    hops: z
      .number({ error: "memory.v2.hops must be a number" })
      .int("memory.v2.hops must be an integer")
      .nonnegative("memory.v2.hops must be non-negative")
      .default(2)
      .describe(
        "Maximum BFS distance for spreading activation across the concept graph",
      ),
    top_k: z
      .number({ error: "memory.v2.top_k must be a number" })
      .int("memory.v2.top_k must be an integer")
      .positive("memory.v2.top_k must be a positive integer")
      .default(20)
      .describe(
        "Number of top-activation concept pages considered for injection per turn",
      ),
    epsilon: z
      .number({ error: "memory.v2.epsilon must be a number" })
      .min(0, "memory.v2.epsilon must be >= 0")
      .max(1, "memory.v2.epsilon must be <= 1")
      .default(0.01)
      .describe(
        "Activation cutoff — slugs with activation <= epsilon are dropped from the persisted state",
      ),
    dense_weight: z
      .number({ error: "memory.v2.dense_weight must be a number" })
      .min(0, "memory.v2.dense_weight must be >= 0")
      .max(1, "memory.v2.dense_weight must be <= 1")
      .default(0.7)
      .describe(
        "Weight on dense (cosine) similarity in the hybrid retrieval score",
      ),
    sparse_weight: z
      .number({ error: "memory.v2.sparse_weight must be a number" })
      .min(0, "memory.v2.sparse_weight must be >= 0")
      .max(1, "memory.v2.sparse_weight must be <= 1")
      .default(0.3)
      .describe(
        "Weight on sparse (BM25-style) similarity in the hybrid retrieval score",
      ),
    consolidation_interval_hours: z
      .number({
        error: "memory.v2.consolidation_interval_hours must be a number",
      })
      .int("memory.v2.consolidation_interval_hours must be an integer")
      .positive(
        "memory.v2.consolidation_interval_hours must be a positive integer",
      )
      .default(1)
      .describe(
        "Hours between scheduled consolidation runs that synthesize buffered memories into concept pages",
      ),
    max_page_chars: z
      .number({ error: "memory.v2.max_page_chars must be a number" })
      .int("memory.v2.max_page_chars must be an integer")
      .positive("memory.v2.max_page_chars must be a positive integer")
      .default(5000)
      .describe(
        "Soft upper bound on concept-page body length — pages exceeding this are flagged for split during consolidation",
      ),
  })
  .describe(
    "Memory v2 — concept-page activation model with hourly LLM-driven consolidation",
  )
  .superRefine((config, ctx) => {
    const activationSum =
      config.d + config.c_user + config.c_assistant + config.c_now;
    if (Math.abs(activationSum - 1.0) >= WEIGHT_SUM_TOLERANCE) {
      const message = `memory.v2 activation weights (d + c_user + c_assistant + c_now) must sum to 1.0 (got ${activationSum.toFixed(4)})`;
      // Emit on every contributing field so validateWithSchema's
      // delete-and-retry repair can strip the offending values and fall
      // back to the documented defaults rather than wiping the whole v2
      // block.
      for (const path of ["d", "c_user", "c_assistant", "c_now"] as const) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message,
        });
      }
    }
    const hybridSum = config.dense_weight + config.sparse_weight;
    if (Math.abs(hybridSum - 1.0) >= WEIGHT_SUM_TOLERANCE) {
      const message = `memory.v2 hybrid weights (dense_weight + sparse_weight) must sum to 1.0 (got ${hybridSum.toFixed(4)})`;
      for (const path of ["dense_weight", "sparse_weight"] as const) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message,
        });
      }
    }
  });

export type MemoryV2Config = z.infer<typeof MemoryV2ConfigSchema>;
