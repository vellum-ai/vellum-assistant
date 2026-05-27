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
 * ONNX weight precision passed to `@huggingface/transformers`. Sourced from
 * transformers.js's supported `dtype` values; `q8` (int8) is ~3× faster than
 * `fp32` on CPU with negligible reranker accuracy loss. Single source of
 * truth for both the schema enum and the `LocalRerankBackend` type.
 */
export const RerankDtypeEnum = z.enum([
  "fp32",
  "fp16",
  "q8",
  "int8",
  "uint8",
  "q4",
  "bnb4",
  "q4f16",
]);
export type RerankDtype = z.infer<typeof RerankDtypeEnum>;

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
        "Whether the v2 memory subsystem (concept-page activation model) is enabled.",
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
      .default(25)
      .describe(
        "Number of top-activation entries (concept pages and skills combined) considered for injection per turn. Skills are scored alongside concepts in the same pool; this cap covers both.",
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
    consolidation_max_buffer_lines: z
      .number({
        error: "memory.v2.consolidation_max_buffer_lines must be a number",
      })
      .int("memory.v2.consolidation_max_buffer_lines must be an integer")
      .positive(
        "memory.v2.consolidation_max_buffer_lines must be a positive integer",
      )
      .nullable()
      .default(100)
      .describe(
        "Size-based trigger for consolidation. When `memory/buffer.md` reaches this many non-empty lines, consolidation runs even if the time-based interval hasn't elapsed. Defaults to 100. Set to `null` to disable the size trigger and rely solely on `consolidation_interval_hours`.",
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
            "Whether to apply cross-encoder reranking as an additive A_o boost on the user + assistant channels. Disabled by default — opt in once measured.",
          ),
        top_k: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(50)
          .describe(
            "Number of candidates from the top of the pre-rerank-A_o pool to send through the reranker. Tail candidates contribute zero rerank boost and keep their pure fused activation.",
          ),
        alpha: z
          .number()
          .min(0)
          .max(1)
          .default(0.3)
          .describe(
            "Per-channel rerank weight: each top-K slug gets `alpha · normalized_rerank` added to A_o weighted by `c_user` (user channel) or `c_assistant` (assistant channel). Top reranker hit can lift A_o by up to `(c_user + c_assistant) · alpha`; bottom of top_k stays roughly unchanged.",
          ),
        model: z
          .string()
          .default(DEFAULT_RERANK_MODEL)
          .describe(
            "HuggingFace model id for the cross-encoder. Must have an ONNX export reachable from huggingface.co/<model>/resolve/main/onnx/model.onnx.",
          ),
        dtype: RerankDtypeEnum.default("q8").describe(
          "ONNX weight precision passed to `@huggingface/transformers`. `q8` (int8) is ~3× faster than `fp32` on CPU with negligible reranker accuracy loss. The worker fails to spawn if the configured model has no matching quantized export — `reranker.ts` then falls back to pure fused scores for the turn.",
        ),
      })
      .default({
        enabled: false,
        top_k: 50,
        alpha: 0.3,
        model: DEFAULT_RERANK_MODEL,
        dtype: "q8",
      })
      .describe(
        "Cross-encoder rerank configuration. When enabled, picks the top-K candidates by pre-rerank A_o, runs the cross-encoder once per channel (user, assistant) on that unified set, and adds an alpha-weighted normalized boost to A_o for each scored slug.",
      ),
    router: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe(
            "Whether to use the LLM router as the per-turn page-selection mechanism in place of spreading activation. Enabled by default.",
          ),
        max_page_ids: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe(
            "Upper bound on the number of concept-page ids the router may return per turn. Caps both prompt size and downstream injection budget.",
          ),
        router_prompt_path: z
          .string({
            error: "memory.v2.router.router_prompt_path must be a string",
          })
          .nullable()
          .default(null)
          .describe(
            "Optional path to a file whose contents replace the bundled router prompt. Absolute paths are used as-is, a leading `~/` is expanded to the home directory, otherwise the path is resolved under the workspace root. The loaded contents may include `{{ASSISTANT_NAME}}`, `{{USER_NAME}}`, and `{{PAGE_INDEX}}`, which are substituted at runtime. If the file is missing, unreadable, or empty, the bundled prompt is used and a warning is logged.",
          ),
        batch_size: z
          .number()
          .int()
          .min(1)
          .nullable()
          .default(null)
          .describe(
            "Target batch size for parallel page-index routing. `null` (default) sends the entire page index in one call — identical to v3 behavior. When set, pages are split into `ceil(N / batch_size)` batches by stable FNV-1a hash on slug (so adding/removing a single page only invalidates one batch's KV cache), routed in parallel, and the selected slugs are unioned. A failure in one batch does not abort the turn as long as at least one batch succeeds.",
          ),
        tier1_size: z
          .number()
          .int()
          .min(1)
          .nullable()
          .default(null)
          .describe(
            "Pool size for the tier-1 'recently modified' batch. `null` (default) disables tier 1 entirely — all pages flow through tier 3 batching. When set, the top-N concept pages by file mtime become their own dedicated parallel batch with mtime-desc ordering; everything else is partitioned into tier 3 batches by `batch_size`. Synthetic entries (skills, CLI commands) have mtime=0 and naturally rank below real concept pages so they don't crowd tier 1.",
          ),
        tier2_size: z
          .number()
          .int()
          .min(1)
          .nullable()
          .default(null)
          .describe(
            "Pool size for the tier-2 'useful' batch. `null` (default) disables tier 2 — pages skip straight from tier 1 to tier 3. When set, the top-M pages by injection-frequency EMA (excluding tier 1) become their own parallel batch ordered by score desc. Pages with score 0 (never selected since EMA tracking began) are ineligible for tier 2 and stay in tier 3 regardless of `tier2_size`. Score is the time-decayed sum `Σ exp(-λ(now - tᵢ))` with 3-day half-life, computed on read from `memory_v2_injection_events`.",
          ),
        historical_pairs: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe(
            "Number of recent (assistant, user) turn pairs to render inside the router prompt's `<last_turn>` block. Each pair is the assistant's reply followed by the user message that came after; the most recent pair's user line is the just-arrived turn that triggered the router. `1` (default) shows only the prior assistant reply plus the current user message — bit-identical to pre-knob behavior. Higher values walk further back through conversation history to give the router more dialogue context at the cost of larger per-turn prompt size. Pairs are emitted in chronological order (oldest first).",
          ),
        historical_pairs_max_chars: z
          .number()
          .int()
          .min(1)
          .nullable()
          .default(null)
          .describe(
            "Optional character cap on the total message content rendered inside `<last_turn>`. `null` (default) means no limit — every message inside the configured `historical_pairs` window is included verbatim. When set, the router walks the assembled pairs newest-first; messages are included until the budget is exhausted, at which point the oldest still-includable message is front-truncated with a leading `…` marker. Older pairs whose content does not fit are dropped entirely. The cap counts message content only — framing characters (`[assistant]: `, `[user]: `, newlines) are not deducted from the budget. Set this when raising `historical_pairs` on workspaces with long messages so the router prompt stays bounded.",
          ),
      })
      .default({
        enabled: true,
        max_page_ids: 25,
        router_prompt_path: null,
        batch_size: null,
        tier1_size: null,
        tier2_size: null,
        historical_pairs: 1,
        historical_pairs_max_chars: null,
      })
      .describe(
        "LLM router configuration. When enabled, a single router LLM call replaces spreading activation for per-turn page selection.",
      ),
  })
  .describe(
    "Memory v2 — concept-page activation model with periodic LLM-driven consolidation",
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

/**
 * Per-lane system-prompt override for a v3 LLM call site. `override` is an
 * inline prompt string (highest precedence); `path` points at a file whose
 * contents replace the bundled prompt. Both default to `null` (use the bundled
 * prompt). Shared by the filter, descent, and gate entries under
 * `memory.v3.prompts`. The whole object is `.default(...)`-wrapped so an
 * omitted lane parses to `{ override: null, path: null }`.
 */
const V3PromptOverrideSchema = z
  .object({
    override: z
      .string({ error: "memory.v3.prompts.*.override must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Optional inline system-prompt string that replaces the bundled prompt for this lane. Takes precedence over `path`. An empty or whitespace-only string is ignored (falls back to `path` / bundled).",
      ),
    path: z
      .string({ error: "memory.v3.prompts.*.path must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Optional path to a file whose contents replace the bundled prompt for this lane. Absolute paths are used as-is, a leading `~/` expands to the home directory, otherwise the path resolves under the workspace root. If the file is missing, unreadable, or empty, the bundled prompt is used and a warning is logged.",
      ),
  })
  .default({ override: null, path: null });

/**
 * Memory v3 (multi-lane, bounded-descent retrieval) configuration.
 *
 * Additive scaffolding only — defaults to `enabled: false` so existing
 * configs are untouched and the v3 retrieval loop stays inert until later
 * PRs wire it up. Every field carries a default and the whole block is
 * `.default(...)`-wrapped so a config that omits `memory.v3` entirely still
 * parses to these documented defaults.
 */
export const MemoryV3ConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "memory.v3.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether the v3 memory subsystem (multi-lane bounded-descent retrieval) is enabled. Off by default until the v3 loop is wired up.",
      ),
    shadow: z
      .boolean({ error: "memory.v3.shadow must be a boolean" })
      .default(false)
      .describe(
        "Live-shadow toggle: when on, the v3 retrieval loop runs alongside the active path for comparison without affecting injected context. Consumed by a later PR.",
      ),
    passCap: z
      .number({ error: "memory.v3.passCap must be a number" })
      .int("memory.v3.passCap must be an integer")
      .default(3)
      .describe(
        "Maximum number of retrieval passes (router → descent rounds) the v3 loop may run per turn.",
      ),
    breadthBudget: z
      .number({ error: "memory.v3.breadthBudget must be a number" })
      .int("memory.v3.breadthBudget must be an integer")
      .default(6)
      .describe(
        "Per-pass breadth budget — the number of frontier candidates the v3 loop may expand at each step.",
      ),
    maxDepth: z
      .number({ error: "memory.v3.maxDepth must be a number" })
      .int("memory.v3.maxDepth must be an integer")
      .default(6)
      .describe(
        "Maximum descent depth the v3 loop traverses through the memory tree before stopping.",
      ),
    denseQuota: z
      .object({
        activeDomain: z
          .number({
            error: "memory.v3.denseQuota.activeDomain must be a number",
          })
          .default(30)
          .describe(
            "Dense-lane candidate quota allocated to the conversation's active domain.",
          ),
        offDomain: z
          .number({ error: "memory.v3.denseQuota.offDomain must be a number" })
          .default(8)
          .describe(
            "Dense-lane candidate quota allocated to off-domain (exploratory) retrieval.",
          ),
      })
      .default({ activeDomain: 30, offDomain: 8 })
      .describe(
        "Dense-lane candidate quotas split between the active domain and off-domain exploration.",
      ),
    hotLimit: z
      .number({ error: "memory.v3.hotLimit must be a number" })
      .int("memory.v3.hotLimit must be an integer")
      .positive("memory.v3.hotLimit must be positive")
      .default(50)
      .describe(
        "Top-N cap on the hot scout lane, ranked by injection-frequency EMA. Hot hits are sticky (kept past the gate), so this bounds how many always-on pages the lane forces into the selection. Without a cap a mature corpus — where nearly every page has been injected at some point — surfaces the entire corpus.",
      ),
    lanes: z
      .object({
        hot: z
          .boolean()
          .default(true)
          .describe("Whether the hot (recently-touched) retrieval lane is on."),
        sparse: z
          .boolean()
          .default(true)
          .describe("Whether the sparse (BM25-style keyword) lane is on."),
        dense: z
          .boolean()
          .default(true)
          .describe("Whether the dense (embedding-similarity) lane is on."),
        tree: z
          .boolean()
          .default(true)
          .describe("Whether the tree (hierarchical descent) lane is on."),
        edges: z
          .boolean()
          .default(true)
          .describe("Whether the edges (graph-adjacency) lane is on."),
      })
      .default({
        hot: true,
        sparse: true,
        dense: true,
        tree: true,
        edges: true,
      })
      .describe(
        "Per-lane on/off toggles for the v3 multi-lane retrieval fanout. All lanes on by default.",
      ),
    edges: z
      .object({
        learnedAdjacencyThreshold: z
          .number({
            error: "memory.v3.edges.learnedAdjacencyThreshold must be a number",
          })
          .min(0, "memory.v3.edges.learnedAdjacencyThreshold must be >= 0")
          .default(0)
          .describe(
            "Association-strength cutoff for merging the learned co-retrieval graph (memory_v3_auto_edges) into the edge-expansion lane. Seeded edges are weighted seedWeight × NPMI, so this is effectively a minimum-NPMI gate: NPMI ≥ threshold / seedWeight (e.g. with the default seedWeight 2.0, threshold 1.0 ≈ NPMI ≥ 0.5, 1.2 ≈ NPMI ≥ 0.6). When > 0, edges at or above this weight are read via aboveThreshold() and merged with the curated frontmatter graph as expandEdges' extraAdjacency. 0 (default) = OFF: the edge lane uses curated edges only and behavior is unchanged. Seed the learned graph with `assistant memory v3 seed-edges`.",
          ),
        maxPulls: z
          .number({ error: "memory.v3.edges.maxPulls must be a number" })
          .min(0, "memory.v3.edges.maxPulls must be >= 0")
          .default(400)
          .describe(
            "Hard cap on the edge lane's contribution to the gate's candidate pool (the unioned 1–2 hop curated∪learned neighborhood). The shipped default 400 lets a dense curated graph dominate the pool and drown the gate's recall of high-precision hits; lower values (~40) keep the lane focused. 0 effectively disables edge pulls.",
          ),
      })
      .default({ learnedAdjacencyThreshold: 0, maxPulls: 400 })
      .describe(
        "Edge-expansion lane configuration. Gates whether the learned co-retrieval graph augments the curated edge graph.",
      ),
    ks: z
      .array(z.number({ error: "memory.v3.ks entries must be numbers" }))
      .default([5, 10, 25, 50])
      .describe(
        "Evaluation top-K cutoffs the v3 loop reports metrics at (e.g. recall@K).",
      ),
    write: z
      .object({
        enabled: z
          .boolean({ error: "memory.v3.write.enabled must be a boolean" })
          .default(false)
          .describe(
            "Whether v3 consolidation owns the shared-buffer drain + tree build. Off by default — v2 consolidation stays the sole buffer-drainer. Does NOT introduce a separate buffer.",
          ),
        consolidateIntervalMs: z
          .number({
            error: "memory.v3.write.consolidateIntervalMs must be a number",
          })
          .int("memory.v3.write.consolidateIntervalMs must be an integer")
          .positive("memory.v3.write.consolidateIntervalMs must be positive")
          .default(3600000)
          .describe(
            "Interval, in milliseconds, between scheduled v3 consolidation runs once the v3 write path owns the drain. Default 1 hour.",
          ),
        coactivation: z
          .boolean({ error: "memory.v3.write.coactivation must be a boolean" })
          .default(false)
          .describe(
            "Whether v3 consolidation learns co-activation edges during the tree build. Off by default; consumed by a later PR.",
          ),
      })
      .default({
        enabled: false,
        consolidateIntervalMs: 3600000,
        coactivation: false,
      })
      .describe(
        "Memory v3 write-path configuration. All default-off scaffolding — controls whether v3 consolidation owns the shared-buffer drain + tree build. Consumed by later PRs.",
      ),
    prompts: z
      .object({
        filter: V3PromptOverrideSchema.describe(
          "Override for the dense-hit filter lane's system prompt.",
        ),
        descent: V3PromptOverrideSchema.describe(
          "Override for the tree-walk descent driver's system prompt.",
        ),
        gate: V3PromptOverrideSchema.describe(
          "Override for the selection gate's system prompt.",
        ),
      })
      .default({
        filter: { override: null, path: null },
        descent: { override: null, path: null },
        gate: { override: null, path: null },
      })
      .describe(
        "Per-lane system-prompt overrides for the three v3 LLM call sites (filter, descent, gate). Each entry takes an inline `override` string (highest precedence) and/or a file `path` whose contents replace the bundled prompt; absolute paths are used as-is, a leading `~/` expands to the home directory, otherwise the path resolves under the workspace root. An empty/whitespace inline override or a missing/unreadable/empty file falls back to the bundled prompt. Lets the prompts be iterated at runtime without a rebuild/restart — mirroring `memory.v2.router.router_prompt_path`.",
      ),
    gateCandidateSummaries: z
      .boolean({
        error: "memory.v3.gateCandidateSummaries must be a boolean",
      })
      .default(false)
      .describe(
        "When true, the selection gate sees each candidate as `slug — summary` instead of the bare slug, so it can judge relevance on page content. Off by default: with the bundled (precision-leaning) gate prompt this makes the gate more selective. It pays off paired with a recall-leaning gate prompt override, where the summaries let the gate recognize non-obvious associative/emotional matches it would otherwise pass over. Adds the candidate summaries to the gate prompt (larger input).",
      ),
  })
  .default({
    enabled: false,
    shadow: false,
    passCap: 3,
    breadthBudget: 6,
    maxDepth: 6,
    denseQuota: { activeDomain: 30, offDomain: 8 },
    hotLimit: 50,
    lanes: { hot: true, sparse: true, dense: true, tree: true, edges: true },
    edges: { learnedAdjacencyThreshold: 0, maxPulls: 400 },
    ks: [5, 10, 25, 50],
    write: {
      enabled: false,
      consolidateIntervalMs: 3600000,
      coactivation: false,
    },
    prompts: {
      filter: { override: null, path: null },
      descent: { override: null, path: null },
      gate: { override: null, path: null },
    },
    gateCandidateSummaries: false,
  })
  .describe(
    "Memory v3 — multi-lane bounded-descent retrieval. Additive scaffolding, disabled by default.",
  );

export type MemoryV3Config = z.infer<typeof MemoryV3ConfigSchema>;
