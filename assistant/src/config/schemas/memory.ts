import { z } from "zod";

import {
  MemoryCleanupConfigSchema,
  MemoryJobsConfigSchema,
  MemoryRetentionConfigSchema,
} from "./memory-lifecycle.js";
import {
  MemoryConflictsConfigSchema,
  MemoryEntityConfigSchema,
  MemoryExtractionConfigSchema,
  MemoryProfileConfigSchema,
  MemorySummarizationConfigSchema,
} from "./memory-processing.js";
import { MemoryRetrievalConfigSchema } from "./memory-retrieval.js";
import {
  MemoryEmbeddingsConfigSchema,
  MemorySegmentationConfigSchema,
  QdrantConfigSchema,
} from "./memory-storage.js";

export const MemoryConfigSchema = z.object({
  enabled: z
    .boolean({ error: "memory.enabled must be a boolean" })
    .default(true),
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
  extraction: MemoryExtractionConfigSchema.default(
    MemoryExtractionConfigSchema.parse({}),
  ),
  summarization: MemorySummarizationConfigSchema.default(
    MemorySummarizationConfigSchema.parse({}),
  ),
  entity: MemoryEntityConfigSchema.default(MemoryEntityConfigSchema.parse({})),
  conflicts: MemoryConflictsConfigSchema.default(
    MemoryConflictsConfigSchema.parse({}),
  ),
  profile: MemoryProfileConfigSchema.default(
    MemoryProfileConfigSchema.parse({}),
  ),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
