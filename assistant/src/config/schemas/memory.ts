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

/**
 * Procedural-memory-as-skills tuning: a recurring procedure is captured as a
 * candidate note and distilled into a managed skill once it recurs.
 */
export const MemoryProcToSkillsConfigSchema = z
  .object({
    minRecurrence: z
      .number({ error: "memory.procToSkills.minRecurrence must be a number" })
      .int("memory.procToSkills.minRecurrence must be an integer")
      .min(1, "memory.procToSkills.minRecurrence must be at least 1")
      .default(2)
      .describe(
        "Number of recurrences of the same procedure before a candidate is distilled into a skill. An explicitly taught procedure distills immediately, bypassing this gate.",
      ),
  })
  .describe("Procedural-memory-as-skills recurrence/distillation tuning.");

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
    procToSkills: MemoryProcToSkillsConfigSchema.default(
      MemoryProcToSkillsConfigSchema.parse({}),
    ),
  })
  .describe(
    "Long-term memory system — stores, retrieves, and manages persistent knowledge across conversations",
  );

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
