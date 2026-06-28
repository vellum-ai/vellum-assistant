import { z } from "zod";

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
    provider: z
      .enum(["auto", "graph", "v2", "v3", "none"])
      .default("auto")
      .describe(
        'Which memory provider drives retrieval and post-turn writes. "auto" (the default) preserves the existing selection derived from `v2.enabled` and the memory-v3-live flag, so it is behavior-neutral; the concrete provider resolution is wired in a later change. "graph"/"v2"/"v3" pin a specific system and "none" disables memory.',
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
  })
  .describe(
    "Long-term memory system — stores, retrieves, and manages persistent knowledge across conversations",
  );

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
