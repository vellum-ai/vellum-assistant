import { z } from "zod";

import {
  MemoryCleanupConfigSchema,
  MemoryJobsConfigSchema,
  MemoryMaintenanceConfigSchema,
  MemoryRetentionConfigSchema,
} from "./memory-lifecycle.js";
import {
  MemoryExtractionConfigSchema,
  MemorySummarizationConfigSchema,
} from "./memory-processing.js";
import { MemoryRetrievalConfigSchema } from "./memory-retrieval.js";
import { MemoryRetrospectiveConfigSchema } from "./memory-retrospective.js";
import {
  MemoryEmbeddingsConfigSchema,
  MemorySegmentationConfigSchema,
  QdrantConfigSchema,
} from "./memory-storage.js";
import { MemorySubstrateConfigSchema } from "./memory-substrate.js";
import { MemoryV2ConfigSchema, WEIGHT_SUM_TOLERANCE } from "./memory-v2.js";
import { MemoryV3ConfigSchema } from "./memory-v3.js";

export const MemoryConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "memory.enabled must be a boolean" })
      .default(true)
      .describe(
        "Whether the long-term memory system is enabled — gates background memory jobs, embedding generation, and `<memory>` block injection into user messages",
      ),
    embeddings: MemoryEmbeddingsConfigSchema.default(
      MemoryEmbeddingsConfigSchema.parse({}),
    ),
    qdrant: QdrantConfigSchema.default(QdrantConfigSchema.parse({})),
    retrieval: MemoryRetrievalConfigSchema.default(
      MemoryRetrievalConfigSchema.parse({}),
    ),
    segmentation: MemorySegmentationConfigSchema.default(
      MemorySegmentationConfigSchema.parse({}),
    ),
    jobs: MemoryJobsConfigSchema.default(MemoryJobsConfigSchema.parse({})),
    retention: MemoryRetentionConfigSchema.default(
      MemoryRetentionConfigSchema.parse({}),
    ),
    cleanup: MemoryCleanupConfigSchema.default(
      MemoryCleanupConfigSchema.parse({}),
    ),
    maintenance: MemoryMaintenanceConfigSchema.default(
      MemoryMaintenanceConfigSchema.parse({}),
    ),
    extraction: MemoryExtractionConfigSchema.default(
      MemoryExtractionConfigSchema.parse({}),
    ),
    summarization: MemorySummarizationConfigSchema.default(
      MemorySummarizationConfigSchema.parse({}),
    ),
    substrate: MemorySubstrateConfigSchema.default(
      MemorySubstrateConfigSchema.parse({}),
    ),
    v2: MemoryV2ConfigSchema.default(MemoryV2ConfigSchema.parse({})),
    v3: MemoryV3ConfigSchema.default(MemoryV3ConfigSchema.parse({})),
    retrospective: MemoryRetrospectiveConfigSchema.default(
      MemoryRetrospectiveConfigSchema.parse({}),
    ),
  })
  .describe(
    "Long-term memory system — stores, retrieves, and manages persistent knowledge across conversations",
  )
  // Cross-field memory invariants live on this schema (not the assistant
  // schema's refinement) so every parse of the memory slice enforces them —
  // the full-config parse via AssistantConfigSchema and the memory plugin's
  // own slice parse alike. Parent parses prefix issue paths with "memory",
  // preserving the loader's per-field fallback paths.
  .superRefine((config, ctx) => {
    const segmentation = config.segmentation;
    if (
      segmentation &&
      segmentation.overlapTokens >= segmentation.targetTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segmentation", "overlapTokens"],
        message:
          "memory.segmentation.overlapTokens must be less than memory.segmentation.targetTokens",
      });
    }
    const dynamicBudget = config.retrieval?.dynamicBudget;
    if (
      dynamicBudget &&
      dynamicBudget.minInjectTokens > dynamicBudget.maxInjectTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieval", "dynamicBudget"],
        message:
          "memory.retrieval.dynamicBudget.minInjectTokens must be <= memory.retrieval.dynamicBudget.maxInjectTokens",
      });
    }
    const injection = config.retrieval?.injection;
    const ctxLoad = injection?.contextLoad;
    if (
      ctxLoad &&
      ctxLoad.capabilityReserve + ctxLoad.serendipitySlots >= ctxLoad.maxNodes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieval", "injection", "contextLoad"],
        message:
          "memory.retrieval.injection.contextLoad.capabilityReserve + serendipitySlots must be less than maxNodes",
      });
    }
    const perTurn = injection?.perTurn;
    if (
      perTurn &&
      perTurn.capabilityReserve + perTurn.serendipitySlots >= perTurn.maxNodes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieval", "injection", "perTurn"],
        message:
          "memory.retrieval.injection.perTurn.capabilityReserve + serendipitySlots must be less than maxNodes",
      });
    }
    // Resolved hybrid-weight invariant. `resolveSubstrateTuning` pairs each
    // `memory.substrate` weight with its `memory.v2` twin on an
    // undefined-only fallback, so a single substrate weight forms its
    // effective pair with the v2 value (schema default applied by now). The
    // substrate schema's own refinement already covers the both-set case, and
    // the v2 schema covers the neither-set case — this check guards the mixed
    // case those local refinements cannot see.
    const substrateDense = config.substrate?.dense_weight;
    const substrateSparse = config.substrate?.sparse_weight;
    const oneSubstrateWeightSet =
      (substrateDense === undefined) !== (substrateSparse === undefined);
    if (oneSubstrateWeightSet) {
      const effectiveDense =
        substrateDense !== undefined ? substrateDense : config.v2.dense_weight;
      const effectiveSparse =
        substrateSparse !== undefined
          ? substrateSparse
          : config.v2.sparse_weight;
      const effectiveSum = effectiveDense + effectiveSparse;
      if (Math.abs(effectiveSum - 1.0) >= WEIGHT_SUM_TOLERANCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            "substrate",
            substrateDense !== undefined ? "dense_weight" : "sparse_weight",
          ],
          message: `memory hybrid weights must sum to 1.0 after memory.substrate → memory.v2 fallback (effective dense_weight ${effectiveDense.toFixed(4)} + sparse_weight ${effectiveSparse.toFixed(4)} = ${effectiveSum.toFixed(4)})`,
        });
      }
    }
  });

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
