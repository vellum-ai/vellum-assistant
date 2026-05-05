import { z } from "zod";

/**
 * Tolerance for floating-point comparisons of weight sums. Using 0.001 lets
 * users specify weights to three decimal places without spurious rejections,
 * while still catching obvious mis-sums.
 */
const WEIGHT_SUM_TOLERANCE = 0.001;

/**
 * Default cross-encoder model for memory v2 reranking.
 * `Alibaba-NLP/gte-reranker-modernbert-base` (149M, Apache-2.0) — 2025
 * ModernBERT-backbone reranker; smaller, newer, and cleaner-licensed than
 * the bge family while matching or beating their retrieval-benchmark scores.
 * Has ONNX exports at the standard `onnx/model.onnx` path.
 */
const DEFAULT_RERANK_MODEL = "Alibaba-NLP/gte-reranker-modernbert-base";

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
      .default(true)
      .describe(
        "Whether the v2 memory subsystem (concept-page activation model) is enabled. Independent of the memory-v2-enabled feature flag — both must be true for v2 to run.",
      ),
    sweep_enabled: z
      .boolean({ error: "memory.v2.sweep_enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether the v2 idle-debounced sweep job is enabled. Off by default — `remember()` is the primary capture path; opt in only when the model is missing entries the sweep would have caught.",
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
    ann_candidate_limit: z
      .number({ error: "memory.v2.ann_candidate_limit must be a number" })
      .int("memory.v2.ann_candidate_limit must be an integer")
      .positive("memory.v2.ann_candidate_limit must be a positive integer")
      .nullable()
      .default(null)
      .describe(
        "Per-channel cap on the unrestricted ANN candidate query (dense and sparse each return up to this many hits before they are unioned and fed into the activation pipeline). `null` = unlimited (every page in the v2 collection is eligible). Increase or null this out to surface more candidates at the cost of higher per-turn embedding/scoring work.",
      ),
    top_k_skills: z
      .number({ error: "memory.v2.top_k_skills must be a number" })
      .int()
      .nonnegative()
      .default(5)
      .describe(
        "Cap on the per-turn skill-autoinjection slate rendered in `### Skills You Can Use`. 0 disables skill autoinjection without code changes.",
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
      .default(0.85)
      .describe(
        "Weight on dense (cosine) similarity in the hybrid retrieval score — dense embeddings dominate the score.",
      ),
    sparse_weight: z
      .number({ error: "memory.v2.sparse_weight must be a number" })
      .min(0, "memory.v2.sparse_weight must be >= 0")
      .max(1, "memory.v2.sparse_weight must be <= 1")
      .default(0.15)
      .describe(
        "Weight on sparse (BM25-style) similarity in the hybrid retrieval score — sparse acts as a discriminator for keyword-rich queries.",
      ),
    // Adaptive sparse-weighting knobs. Both fields are intentionally
    // optional with no default — the schema serialiser drops absent
    // optionals so these stay invisible to operators who never tune them.
    // The defaults live in `effectiveWeights` (sim.ts).
    min_sparse_spread: z
      .number({ error: "memory.v2.min_sparse_spread must be a number" })
      .min(0, "memory.v2.min_sparse_spread must be >= 0")
      .max(1, "memory.v2.min_sparse_spread must be <= 1")
      .optional()
      .describe(
        "Adaptive sparse weighting: when the spread (max - min) of normalized sparse scores across the candidate hit set falls below this, sparse contribution collapses to 0. Linear interpolation between this and `full_sparse_spread`. Optional escape hatch — leave unset to use the built-in default.",
      ),
    full_sparse_spread: z
      .number({ error: "memory.v2.full_sparse_spread must be a number" })
      .min(0, "memory.v2.full_sparse_spread must be >= 0")
      .max(1, "memory.v2.full_sparse_spread must be <= 1")
      .optional()
      .describe(
        "Adaptive sparse weighting: at or above this spread, sparse weight stays at the configured `sparse_weight`. Optional escape hatch — leave unset to use the built-in default.",
      ),
    bm25_k1: z
      .number({ error: "memory.v2.bm25_k1 must be a number" })
      .min(0, "memory.v2.bm25_k1 must be >= 0")
      .default(1.2)
      .describe(
        "BM25 term-frequency saturation parameter. Standard Lucene default — increase to make repeated mentions of a term matter more, decrease to flatten the curve.",
      ),
    bm25_b: z
      .number({ error: "memory.v2.bm25_b must be a number" })
      .min(0, "memory.v2.bm25_b must be >= 0")
      .max(1, "memory.v2.bm25_b must be <= 1")
      .default(0.4)
      .describe(
        "BM25 document-length normalization. 0 disables length normalization, 1 fully normalizes. Lucene's default is 0.75 (tuned for narrative/web corpora); we run lower because concept-page collections include structured list pages with high information density per word — full Lucene normalization over-penalizes them.",
      ),
    consolidation_interval_hours: z
      .number({
        error: "memory.v2.consolidation_interval_hours must be a number",
      })
      .int("memory.v2.consolidation_interval_hours must be an integer")
      .positive(
        "memory.v2.consolidation_interval_hours must be a positive integer",
      )
      .default(4)
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
    consolidation_prompt_path: z
      .string({
        error: "memory.v2.consolidation_prompt_path must be a string",
      })
      .nullable()
      .default(null)
      .describe(
        "Optional path to a file whose contents replace the bundled consolidation prompt. Absolute paths are used as-is, a leading `~/` is expanded to the home directory, otherwise the path is resolved under the workspace root. The loaded contents may include `{{CUTOFF}}`, which is substituted with the run's ISO-8601 cutoff timestamp. If the file is missing, unreadable, or empty, the bundled prompt is used and a warning is logged.",
      ),
    rerank: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Whether to apply cross-encoder reranking as an additive boost to the user + assistant similarity channels. Disabled by default — opt in once measured.",
          ),
        top_k: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(50)
          .describe(
            "Number of top-fused candidates per `simBatch` call to send through the reranker. Tail candidates keep their pure fused score.",
          ),
        alpha: z
          .number()
          .min(0)
          .max(1)
          .default(0.3)
          .describe(
            "Boost weight: `boosted = clamp01(fused + alpha · normalized_rerank)`. Top reranker hit can lift its fused score by up to `alpha`; bottom of top_k stays roughly unchanged.",
          ),
        model: z
          .string()
          .default(DEFAULT_RERANK_MODEL)
          .describe(
            "HuggingFace model id for the cross-encoder. Must have an ONNX export reachable from huggingface.co/<model>/resolve/main/onnx/model.onnx.",
          ),
      })
      .default({
        enabled: false,
        top_k: 50,
        alpha: 0.3,
        model: DEFAULT_RERANK_MODEL,
      })
      .describe(
        "Cross-encoder rerank configuration. When enabled, runs a local cross-encoder over the top-K fused candidates per `simBatch(useRerank: true)` call and adds an alpha-weighted normalized boost to their fused scores.",
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
