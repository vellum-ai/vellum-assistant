import { z } from "zod";

import { WEIGHT_SUM_TOLERANCE } from "./memory-v2.js";

/**
 * Memory substrate (shared concept-page infrastructure) tuning.
 *
 * Every key is optional with no default: an unset key resolves to its
 * historical `memory.v2` counterpart via `resolveSubstrateTuning` (the
 * substrate's single config choke point), so the v2 schema keeps supplying
 * the effective defaults. `spread_k`, `spread_hops`, and
 * `ann_candidate_limit` map onto `memory.v2.k`, `memory.v2.hops`, and
 * `memory.v2.ann_candidate_limit` respectively; every other key shares its
 * name with its `memory.v2` twin.
 */
export const MemorySubstrateConfigSchema = z
  .object({
    sweep_enabled: z
      .boolean({ error: "memory.substrate.sweep_enabled must be a boolean" })
      .optional()
      .describe(
        "Whether the idle-debounced memory sweep job is enabled. `remember()` is the primary capture path; opt in only when the model is missing entries the sweep would have caught.",
      ),
    dense_weight: z
      .number({ error: "memory.substrate.dense_weight must be a number" })
      .min(0, "memory.substrate.dense_weight must be >= 0")
      .max(1, "memory.substrate.dense_weight must be <= 1")
      .optional()
      .describe(
        "Weight on dense (cosine) similarity in the hybrid retrieval score.",
      ),
    sparse_weight: z
      .number({ error: "memory.substrate.sparse_weight must be a number" })
      .min(0, "memory.substrate.sparse_weight must be >= 0")
      .max(1, "memory.substrate.sparse_weight must be <= 1")
      .optional()
      .describe(
        "Weight on sparse (BM25-style) similarity in the hybrid retrieval score — sparse acts as a discriminator for keyword-rich queries.",
      ),
    min_sparse_spread: z
      .number({ error: "memory.substrate.min_sparse_spread must be a number" })
      .min(0, "memory.substrate.min_sparse_spread must be >= 0")
      .max(1, "memory.substrate.min_sparse_spread must be <= 1")
      .optional()
      .describe(
        "Adaptive sparse weighting: when the spread (max - min) of normalized sparse scores across the candidate hit set falls below this, sparse contribution collapses to 0. Linear interpolation between this and `full_sparse_spread`. Optional escape hatch — leave unset to use the built-in default.",
      ),
    full_sparse_spread: z
      .number({ error: "memory.substrate.full_sparse_spread must be a number" })
      .min(0, "memory.substrate.full_sparse_spread must be >= 0")
      .max(1, "memory.substrate.full_sparse_spread must be <= 1")
      .optional()
      .describe(
        "Adaptive sparse weighting: at or above this spread, sparse weight stays at the configured `sparse_weight`. Optional escape hatch — leave unset to use the built-in default.",
      ),
    bm25_k1: z
      .number({ error: "memory.substrate.bm25_k1 must be a number" })
      .min(0, "memory.substrate.bm25_k1 must be >= 0")
      .optional()
      .describe(
        "BM25 term-frequency saturation parameter. Increase to make repeated mentions of a term matter more, decrease to flatten the curve.",
      ),
    bm25_b: z
      .number({ error: "memory.substrate.bm25_b must be a number" })
      .min(0, "memory.substrate.bm25_b must be >= 0")
      .max(1, "memory.substrate.bm25_b must be <= 1")
      .optional()
      .describe(
        "BM25 document-length normalization. 0 disables length normalization, 1 fully normalizes. Concept-page collections include structured list pages with high information density per word, so values below Lucene's 0.75 default avoid over-penalizing them.",
      ),
    consolidation_interval_hours: z
      .number({
        error: "memory.substrate.consolidation_interval_hours must be a number",
      })
      .int("memory.substrate.consolidation_interval_hours must be an integer")
      .positive(
        "memory.substrate.consolidation_interval_hours must be a positive integer",
      )
      .optional()
      .describe(
        "Hours between scheduled consolidation runs that synthesize buffered memories into concept pages",
      ),
    consolidation_max_buffer_lines: z
      .number({
        error:
          "memory.substrate.consolidation_max_buffer_lines must be a number",
      })
      .int("memory.substrate.consolidation_max_buffer_lines must be an integer")
      .positive(
        "memory.substrate.consolidation_max_buffer_lines must be a positive integer",
      )
      .nullable()
      .optional()
      .describe(
        "Size-based trigger for consolidation. When `memory/buffer.md` reaches this many non-empty lines, consolidation runs even if the time-based interval hasn't elapsed. Set to `null` to disable the size trigger and rely solely on `consolidation_interval_hours`.",
      ),
    consolidation_max_entries_per_run: z
      .number({
        error:
          "memory.substrate.consolidation_max_entries_per_run must be a number",
      })
      .int(
        "memory.substrate.consolidation_max_entries_per_run must be an integer",
      )
      .positive(
        "memory.substrate.consolidation_max_entries_per_run must be a positive integer",
      )
      .nullable()
      .optional()
      .describe(
        "Upper bound on buffer entries one consolidation run may process. When the buffer holds more, the run's cutoff is moved back to the first over-cap entry's timestamp so the overflow is deferred to a follow-up pass. Bounds the context a single agentic run must read after a backlog. Set to `null` to always process the full buffer.",
      ),
    max_page_chars: z
      .number({ error: "memory.substrate.max_page_chars must be a number" })
      .int("memory.substrate.max_page_chars must be an integer")
      .positive("memory.substrate.max_page_chars must be a positive integer")
      .optional()
      .describe(
        "Soft upper bound on concept-page body length — pages exceeding this are flagged for split during consolidation",
      ),
    consolidation_prompt_path: z
      .string({
        error: "memory.substrate.consolidation_prompt_path must be a string",
      })
      .nullable()
      .optional()
      .describe(
        "Optional path to a file whose contents replace the bundled consolidation prompt. Relative paths resolve under the workspace root; absolute paths and a leading `~/` (expanded to the home directory) are honored only when they still resolve inside the workspace root — a path that lands outside the workspace (including via symlinks) is rejected. The loaded contents may include `{{CUTOFF}}`, which is substituted with the run's ISO-8601 cutoff timestamp. If the file is rejected, missing, unreadable, or empty, the bundled prompt is used and a warning is logged.",
      ),
    spread_k: z
      .number({ error: "memory.substrate.spread_k must be a number" })
      .min(0, "memory.substrate.spread_k must be >= 0")
      .max(1, "memory.substrate.spread_k must be <= 1")
      .optional()
      .describe(
        "Spreading-activation propagation coefficient — fraction of own activation that flows to neighbors per hop. Falls back to `memory.v2.k`.",
      ),
    spread_hops: z
      .number({ error: "memory.substrate.spread_hops must be a number" })
      .int("memory.substrate.spread_hops must be an integer")
      .nonnegative("memory.substrate.spread_hops must be non-negative")
      .optional()
      .describe(
        "Maximum BFS distance for spreading activation across the concept graph. Falls back to `memory.v2.hops`.",
      ),
    ann_candidate_limit: z
      .number({
        error: "memory.substrate.ann_candidate_limit must be a number",
      })
      .int("memory.substrate.ann_candidate_limit must be an integer")
      .positive(
        "memory.substrate.ann_candidate_limit must be a positive integer",
      )
      .nullable()
      .optional()
      .describe(
        "Per-channel cap on the unrestricted ANN candidate query used by memory recall (dense and sparse each return up to this many hits before they are unioned). `null` = unlimited (every page in the concept-page collection is eligible).",
      ),
  })
  .describe(
    "Memory substrate tuning — overrides for the shared concept-page infrastructure (consolidation, hybrid retrieval, BM25 encoding, sweep). Unset keys resolve to their historical `memory.v2` counterparts.",
  )
  .superRefine((config, ctx) => {
    if (
      config.dense_weight === undefined ||
      config.sparse_weight === undefined
    ) {
      return;
    }
    const hybridSum = config.dense_weight + config.sparse_weight;
    if (Math.abs(hybridSum - 1.0) >= WEIGHT_SUM_TOLERANCE) {
      const message = `memory.substrate hybrid weights (dense_weight + sparse_weight) must sum to 1.0 (got ${hybridSum.toFixed(4)})`;
      for (const path of ["dense_weight", "sparse_weight"] as const) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message,
        });
      }
    }
  });

export type MemorySubstrateConfig = z.infer<typeof MemorySubstrateConfigSchema>;
