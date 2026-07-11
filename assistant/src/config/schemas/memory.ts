import { z } from "zod";

import { CodeGraphConfigSchema } from "./memory-code-graph.js";
import {
  MemoryCleanupConfigSchema,
  MemoryJobsConfigSchema,
  MemoryMaintenanceConfigSchema,
  MemoryRetentionConfigSchema,
  MemoryWorkerConfigSchema,
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
import { MemoryV2ConfigSchema } from "./memory-v2.js";
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
    worker: MemoryWorkerConfigSchema.default(
      MemoryWorkerConfigSchema.parse({}),
    ),
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
    v2: MemoryV2ConfigSchema.default(MemoryV2ConfigSchema.parse({})),
    v3: MemoryV3ConfigSchema.default(MemoryV3ConfigSchema.parse({})),
    retrospective: MemoryRetrospectiveConfigSchema.default(
      MemoryRetrospectiveConfigSchema.parse({}),
    ),
    codeGraph: CodeGraphConfigSchema.default(CodeGraphConfigSchema.parse({})),
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
  });

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
