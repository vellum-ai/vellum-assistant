import { z } from "zod";

const VALID_MEMORY_ITEM_KINDS = [
  "preference",
  "profile",
  "project",
  "decision",
  "todo",
  "fact",
  "constraint",
  "relationship",
  "event",
  "opinion",
  "instruction",
  "style",
] as const;

const DEFAULT_CONFLICTABLE_KINDS = [
  "preference",
  "profile",
  "constraint",
  "instruction",
  "style",
] as const;

export const MemoryExtractionConfigSchema = z.object({
  useLLM: z
    .boolean({ error: "memory.extraction.useLLM must be a boolean" })
    .default(true),
  modelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "memory.extraction.modelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
  extractFromAssistant: z
    .boolean({
      error: "memory.extraction.extractFromAssistant must be a boolean",
    })
    .default(true),
});

export const MemorySummarizationConfigSchema = z.object({
  useLLM: z
    .boolean({ error: "memory.summarization.useLLM must be a boolean" })
    .default(true),
  modelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "memory.summarization.modelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
});

export const MemoryEntityConfigSchema = z.object({
  enabled: z
    .boolean({ error: "memory.entity.enabled must be a boolean" })
    .default(true),
  modelIntent: z
    .enum(["latency-optimized", "quality-optimized", "vision-optimized"], {
      error: "memory.entity.modelIntent must be a valid model intent",
    })
    .default("latency-optimized"),
  extractRelations: z
    .object({
      enabled: z
        .boolean({
          error: "memory.entity.extractRelations.enabled must be a boolean",
        })
        .default(true),
      backfillBatchSize: z
        .number({
          error:
            "memory.entity.extractRelations.backfillBatchSize must be a number",
        })
        .int(
          "memory.entity.extractRelations.backfillBatchSize must be an integer",
        )
        .positive(
          "memory.entity.extractRelations.backfillBatchSize must be a positive integer",
        )
        .default(200),
    })
    .default({ enabled: true, backfillBatchSize: 200 }),
  relationRetrieval: z
    .object({
      enabled: z
        .boolean({
          error: "memory.entity.relationRetrieval.enabled must be a boolean",
        })
        .default(true),
      maxSeedEntities: z
        .number({
          error:
            "memory.entity.relationRetrieval.maxSeedEntities must be a number",
        })
        .int(
          "memory.entity.relationRetrieval.maxSeedEntities must be an integer",
        )
        .positive(
          "memory.entity.relationRetrieval.maxSeedEntities must be a positive integer",
        )
        .default(8),
      maxNeighborEntities: z
        .number({
          error:
            "memory.entity.relationRetrieval.maxNeighborEntities must be a number",
        })
        .int(
          "memory.entity.relationRetrieval.maxNeighborEntities must be an integer",
        )
        .positive(
          "memory.entity.relationRetrieval.maxNeighborEntities must be a positive integer",
        )
        .default(20),
      maxEdges: z
        .number({
          error: "memory.entity.relationRetrieval.maxEdges must be a number",
        })
        .int("memory.entity.relationRetrieval.maxEdges must be an integer")
        .positive(
          "memory.entity.relationRetrieval.maxEdges must be a positive integer",
        )
        .default(40),
      neighborScoreMultiplier: z
        .number({
          error:
            "memory.entity.relationRetrieval.neighborScoreMultiplier must be a number",
        })
        .gt(
          0,
          "memory.entity.relationRetrieval.neighborScoreMultiplier must be > 0",
        )
        .lte(
          1,
          "memory.entity.relationRetrieval.neighborScoreMultiplier must be <= 1",
        )
        .default(0.7),
      maxDepth: z
        .number({
          error: "memory.entity.relationRetrieval.maxDepth must be a number",
        })
        .int("memory.entity.relationRetrieval.maxDepth must be an integer")
        .positive(
          "memory.entity.relationRetrieval.maxDepth must be a positive integer",
        )
        .default(3),
      depthDecay: z
        .boolean({
          error: "memory.entity.relationRetrieval.depthDecay must be a boolean",
        })
        .default(true),
    })
    .default({
      enabled: true,
      maxSeedEntities: 8,
      maxNeighborEntities: 20,
      maxEdges: 40,
      neighborScoreMultiplier: 0.7,
      maxDepth: 3,
      depthDecay: true,
    }),
});

export const MemoryConflictsConfigSchema = z.object({
  enabled: z
    .boolean({ error: "memory.conflicts.enabled must be a boolean" })
    .default(true),
  gateMode: z
    .enum(["soft"], { error: 'memory.conflicts.gateMode must be "soft"' })
    .default("soft"),
  resolverLlmTimeoutMs: z
    .number({ error: "memory.conflicts.resolverLlmTimeoutMs must be a number" })
    .int("memory.conflicts.resolverLlmTimeoutMs must be an integer")
    .positive(
      "memory.conflicts.resolverLlmTimeoutMs must be a positive integer",
    )
    .default(12000),
  relevanceThreshold: z
    .number({ error: "memory.conflicts.relevanceThreshold must be a number" })
    .min(0, "memory.conflicts.relevanceThreshold must be >= 0")
    .max(1, "memory.conflicts.relevanceThreshold must be <= 1")
    .default(0.3),
  conflictableKinds: z
    .array(
      z.enum(VALID_MEMORY_ITEM_KINDS, {
        error: `memory.conflicts.conflictableKinds entries must be one of: ${VALID_MEMORY_ITEM_KINDS.join(
          ", ",
        )}`,
      }),
    )
    .nonempty({
      message: "memory.conflicts.conflictableKinds must not be empty",
    })
    .default([...DEFAULT_CONFLICTABLE_KINDS]),
});

export const MemoryProfileConfigSchema = z.object({
  enabled: z
    .boolean({ error: "memory.profile.enabled must be a boolean" })
    .default(true),
  maxInjectTokens: z
    .number({ error: "memory.profile.maxInjectTokens must be a number" })
    .int("memory.profile.maxInjectTokens must be an integer")
    .positive("memory.profile.maxInjectTokens must be a positive integer")
    .default(800),
});

export type MemoryExtractionConfig = z.infer<
  typeof MemoryExtractionConfigSchema
>;
export type MemorySummarizationConfig = z.infer<
  typeof MemorySummarizationConfigSchema
>;
export type MemoryEntityConfig = z.infer<typeof MemoryEntityConfigSchema>;
export type MemoryConflictsConfig = z.infer<typeof MemoryConflictsConfigSchema>;
export type MemoryProfileConfig = z.infer<typeof MemoryProfileConfigSchema>;
