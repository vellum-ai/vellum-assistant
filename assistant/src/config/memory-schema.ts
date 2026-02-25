import { z } from 'zod';

const VALID_MEMORY_EMBEDDING_PROVIDERS = ['auto', 'local', 'openai', 'gemini', 'ollama'] as const;
const VALID_MEMORY_ITEM_KINDS = [
  'preference', 'profile', 'project', 'decision', 'todo',
  'fact', 'constraint', 'relationship', 'event', 'opinion', 'instruction', 'style',
] as const;

const DEFAULT_CONFLICTABLE_KINDS = [
  'preference', 'profile', 'constraint', 'instruction', 'style',
] as const;

const VALID_QDRANT_QUANTIZATION = ['scalar', 'none'] as const;

export const MemoryEmbeddingsConfigSchema = z.object({
  required: z
    .boolean({ error: 'memory.embeddings.required must be a boolean' })
    .default(true),
  provider: z
    .enum(VALID_MEMORY_EMBEDDING_PROVIDERS, {
      error: `memory.embeddings.provider must be one of: ${VALID_MEMORY_EMBEDDING_PROVIDERS.join(', ')}`,
    })
    .default('auto'),
  localModel: z
    .string({ error: 'memory.embeddings.localModel must be a string' })
    .default('Xenova/bge-small-en-v1.5'),
  openaiModel: z
    .string({ error: 'memory.embeddings.openaiModel must be a string' })
    .default('text-embedding-3-small'),
  geminiModel: z
    .string({ error: 'memory.embeddings.geminiModel must be a string' })
    .default('gemini-embedding-001'),
  ollamaModel: z
    .string({ error: 'memory.embeddings.ollamaModel must be a string' })
    .default('nomic-embed-text'),
});

export const QdrantConfigSchema = z.object({
  url: z
    .string({ error: 'memory.qdrant.url must be a string' })
    .default('http://127.0.0.1:6333'),
  collection: z
    .string({ error: 'memory.qdrant.collection must be a string' })
    .default('memory'),
  vectorSize: z
    .number({ error: 'memory.qdrant.vectorSize must be a number' })
    .int('memory.qdrant.vectorSize must be an integer')
    .positive('memory.qdrant.vectorSize must be a positive integer')
    .default(384),
  onDisk: z
    .boolean({ error: 'memory.qdrant.onDisk must be a boolean' })
    .default(true),
  quantization: z
    .enum(VALID_QDRANT_QUANTIZATION, {
      error: `memory.qdrant.quantization must be one of: ${VALID_QDRANT_QUANTIZATION.join(', ')}`,
    })
    .default('scalar'),
});

export const MemoryRerankingConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.retrieval.reranking.enabled must be a boolean' })
    .default(false),
  modelIntent: z
    .enum(['latency-optimized', 'quality-optimized', 'vision-optimized'], {
      error: 'memory.retrieval.reranking.modelIntent must be a valid model intent',
    })
    .default('latency-optimized'),
  topK: z
    .number({ error: 'memory.retrieval.reranking.topK must be a number' })
    .int('memory.retrieval.reranking.topK must be an integer')
    .positive('memory.retrieval.reranking.topK must be a positive integer')
    .default(20),
});

export const MemoryDynamicBudgetConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.retrieval.dynamicBudget.enabled must be a boolean' })
    .default(true),
  minInjectTokens: z
    .number({ error: 'memory.retrieval.dynamicBudget.minInjectTokens must be a number' })
    .int('memory.retrieval.dynamicBudget.minInjectTokens must be an integer')
    .positive('memory.retrieval.dynamicBudget.minInjectTokens must be a positive integer')
    .default(1200),
  maxInjectTokens: z
    .number({ error: 'memory.retrieval.dynamicBudget.maxInjectTokens must be a number' })
    .int('memory.retrieval.dynamicBudget.maxInjectTokens must be an integer')
    .positive('memory.retrieval.dynamicBudget.maxInjectTokens must be a positive integer')
    .default(10000),
  targetHeadroomTokens: z
    .number({ error: 'memory.retrieval.dynamicBudget.targetHeadroomTokens must be a number' })
    .int('memory.retrieval.dynamicBudget.targetHeadroomTokens must be an integer')
    .positive('memory.retrieval.dynamicBudget.targetHeadroomTokens must be a positive integer')
    .default(10000),
});

export const MemoryEarlyTerminationConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.retrieval.earlyTermination.enabled must be a boolean' })
    .default(true),
  minCandidates: z
    .number({ error: 'memory.retrieval.earlyTermination.minCandidates must be a number' })
    .int('memory.retrieval.earlyTermination.minCandidates must be an integer')
    .positive('memory.retrieval.earlyTermination.minCandidates must be a positive integer')
    .default(20),
  minHighConfidence: z
    .number({ error: 'memory.retrieval.earlyTermination.minHighConfidence must be a number' })
    .int('memory.retrieval.earlyTermination.minHighConfidence must be an integer')
    .positive('memory.retrieval.earlyTermination.minHighConfidence must be a positive integer')
    .default(10),
  confidenceThreshold: z
    .number({ error: 'memory.retrieval.earlyTermination.confidenceThreshold must be a number' })
    .min(0, 'memory.retrieval.earlyTermination.confidenceThreshold must be >= 0')
    .max(1, 'memory.retrieval.earlyTermination.confidenceThreshold must be <= 1')
    .default(0.7),
});

/**
 * Per-kind freshness windows (in days). Items older than their window
 * (based on lastSeenAt) are down-ranked unless recently reinforced.
 * A value of 0 disables freshness decay for that kind.
 */
const MemoryFreshnessConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.retrieval.freshness.enabled must be a boolean' })
    .default(true),
  maxAgeDays: z.object({
    fact: z
      .number({ error: 'memory.retrieval.freshness.maxAgeDays.fact must be a number' })
      .nonnegative('memory.retrieval.freshness.maxAgeDays.fact must be non-negative')
      .default(0),
    preference: z
      .number({ error: 'memory.retrieval.freshness.maxAgeDays.preference must be a number' })
      .nonnegative('memory.retrieval.freshness.maxAgeDays.preference must be non-negative')
      .default(0),
    behavior: z
      .number({ error: 'memory.retrieval.freshness.maxAgeDays.behavior must be a number' })
      .nonnegative('memory.retrieval.freshness.maxAgeDays.behavior must be non-negative')
      .default(90),
    event: z
      .number({ error: 'memory.retrieval.freshness.maxAgeDays.event must be a number' })
      .nonnegative('memory.retrieval.freshness.maxAgeDays.event must be non-negative')
      .default(30),
    opinion: z
      .number({ error: 'memory.retrieval.freshness.maxAgeDays.opinion must be a number' })
      .nonnegative('memory.retrieval.freshness.maxAgeDays.opinion must be non-negative')
      .default(60),
  }).default({
    fact: 0,
    preference: 0,
    behavior: 90,
    event: 30,
    opinion: 60,
  }),
  staleDecay: z
    .number({ error: 'memory.retrieval.freshness.staleDecay must be a number' })
    .min(0, 'memory.retrieval.freshness.staleDecay must be >= 0')
    .max(1, 'memory.retrieval.freshness.staleDecay must be <= 1')
    .default(0.5),
  reinforcementShieldDays: z
    .number({ error: 'memory.retrieval.freshness.reinforcementShieldDays must be a number' })
    .nonnegative('memory.retrieval.freshness.reinforcementShieldDays must be non-negative')
    .default(7),
});

export const MemoryRetrievalConfigSchema = z.object({
  lexicalTopK: z
    .number({ error: 'memory.retrieval.lexicalTopK must be a number' })
    .int('memory.retrieval.lexicalTopK must be an integer')
    .positive('memory.retrieval.lexicalTopK must be a positive integer')
    .default(80),
  semanticTopK: z
    .number({ error: 'memory.retrieval.semanticTopK must be a number' })
    .int('memory.retrieval.semanticTopK must be an integer')
    .positive('memory.retrieval.semanticTopK must be a positive integer')
    .default(40),
  maxInjectTokens: z
    .number({ error: 'memory.retrieval.maxInjectTokens must be a number' })
    .int('memory.retrieval.maxInjectTokens must be an integer')
    .positive('memory.retrieval.maxInjectTokens must be a positive integer')
    .default(10000),
  injectionFormat: z
    .enum(['markdown', 'structured_v1'], { error: 'memory.retrieval.injectionFormat must be "markdown" or "structured_v1"' })
    .default('markdown'),
  injectionStrategy: z
    .enum(['prepend_user_block', 'separate_context_message'], {
      error: 'memory.retrieval.injectionStrategy must be "prepend_user_block" or "separate_context_message"',
    })
    .default('prepend_user_block'),
  reranking: MemoryRerankingConfigSchema.default({
    enabled: false,
    modelIntent: 'latency-optimized',
    topK: 20,
  }),
  freshness: MemoryFreshnessConfigSchema.default({
    enabled: true,
    maxAgeDays: {
      fact: 0,
      preference: 0,
      behavior: 90,
      event: 30,
      opinion: 60,
    },
    staleDecay: 0.5,
    reinforcementShieldDays: 7,
  }),
  scopePolicy: z
    .enum(['allow_global_fallback', 'strict'], {
      error: 'memory.retrieval.scopePolicy must be "allow_global_fallback" or "strict"',
    })
    .default('allow_global_fallback'),
  dynamicBudget: MemoryDynamicBudgetConfigSchema.default({
    enabled: true,
    minInjectTokens: 1200,
    maxInjectTokens: 10000,
    targetHeadroomTokens: 10000,
  }),
  earlyTermination: MemoryEarlyTerminationConfigSchema.default({
    enabled: true,
    minCandidates: 20,
    minHighConfidence: 10,
    confidenceThreshold: 0.7,
  }),
});

export const MemorySegmentationConfigSchema = z.object({
  targetTokens: z
    .number({ error: 'memory.segmentation.targetTokens must be a number' })
    .int('memory.segmentation.targetTokens must be an integer')
    .positive('memory.segmentation.targetTokens must be a positive integer')
    .default(450),
  overlapTokens: z
    .number({ error: 'memory.segmentation.overlapTokens must be a number' })
    .int('memory.segmentation.overlapTokens must be an integer')
    .nonnegative('memory.segmentation.overlapTokens must be a non-negative integer')
    .default(60),
});

export const MemoryJobsConfigSchema = z.object({
  workerConcurrency: z
    .number({ error: 'memory.jobs.workerConcurrency must be a number' })
    .int('memory.jobs.workerConcurrency must be an integer')
    .positive('memory.jobs.workerConcurrency must be a positive integer')
    .default(2),
  batchSize: z
    .number({ error: 'memory.jobs.batchSize must be a number' })
    .int('memory.jobs.batchSize must be an integer')
    .positive('memory.jobs.batchSize must be a positive integer')
    .default(10),
});

export const MemoryRetentionConfigSchema = z.object({
  keepRawForever: z
    .boolean({ error: 'memory.retention.keepRawForever must be a boolean' })
    .default(true),
});

export const MemoryCleanupConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.cleanup.enabled must be a boolean' })
    .default(true),
  enqueueIntervalMs: z
    .number({ error: 'memory.cleanup.enqueueIntervalMs must be a number' })
    .int('memory.cleanup.enqueueIntervalMs must be an integer')
    .positive('memory.cleanup.enqueueIntervalMs must be a positive integer')
    .default(6 * 60 * 60 * 1000),
  resolvedConflictRetentionMs: z
    .number({ error: 'memory.cleanup.resolvedConflictRetentionMs must be a number' })
    .int('memory.cleanup.resolvedConflictRetentionMs must be an integer')
    .positive('memory.cleanup.resolvedConflictRetentionMs must be a positive integer')
    .default(30 * 24 * 60 * 60 * 1000),
  supersededItemRetentionMs: z
    .number({ error: 'memory.cleanup.supersededItemRetentionMs must be a number' })
    .int('memory.cleanup.supersededItemRetentionMs must be an integer')
    .positive('memory.cleanup.supersededItemRetentionMs must be a positive integer')
    .default(30 * 24 * 60 * 60 * 1000),
  conversationRetentionDays: z
    .number({ error: 'memory.cleanup.conversationRetentionDays must be a number' })
    .int('memory.cleanup.conversationRetentionDays must be an integer')
    .nonnegative('memory.cleanup.conversationRetentionDays must be non-negative')
    .default(90),
});

export const MemoryExtractionConfigSchema = z.object({
  useLLM: z
    .boolean({ error: 'memory.extraction.useLLM must be a boolean' })
    .default(true),
  modelIntent: z
    .enum(['latency-optimized', 'quality-optimized', 'vision-optimized'], {
      error: 'memory.extraction.modelIntent must be a valid model intent',
    })
    .default('latency-optimized'),
  extractFromAssistant: z
    .boolean({ error: 'memory.extraction.extractFromAssistant must be a boolean' })
    .default(true),
});

export const MemoryEntityConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.entity.enabled must be a boolean' })
    .default(true),
  modelIntent: z
    .enum(['latency-optimized', 'quality-optimized', 'vision-optimized'], {
      error: 'memory.entity.modelIntent must be a valid model intent',
    })
    .default('latency-optimized'),
  extractRelations: z.object({
    enabled: z
      .boolean({ error: 'memory.entity.extractRelations.enabled must be a boolean' })
      .default(true),
    backfillBatchSize: z
      .number({ error: 'memory.entity.extractRelations.backfillBatchSize must be a number' })
      .int('memory.entity.extractRelations.backfillBatchSize must be an integer')
      .positive('memory.entity.extractRelations.backfillBatchSize must be a positive integer')
      .default(200),
  }).default({
    enabled: true,
    backfillBatchSize: 200,
  }),
  relationRetrieval: z.object({
    enabled: z
      .boolean({ error: 'memory.entity.relationRetrieval.enabled must be a boolean' })
      .default(true),
    maxSeedEntities: z
      .number({ error: 'memory.entity.relationRetrieval.maxSeedEntities must be a number' })
      .int('memory.entity.relationRetrieval.maxSeedEntities must be an integer')
      .positive('memory.entity.relationRetrieval.maxSeedEntities must be a positive integer')
      .default(8),
    maxNeighborEntities: z
      .number({ error: 'memory.entity.relationRetrieval.maxNeighborEntities must be a number' })
      .int('memory.entity.relationRetrieval.maxNeighborEntities must be an integer')
      .positive('memory.entity.relationRetrieval.maxNeighborEntities must be a positive integer')
      .default(20),
    maxEdges: z
      .number({ error: 'memory.entity.relationRetrieval.maxEdges must be a number' })
      .int('memory.entity.relationRetrieval.maxEdges must be an integer')
      .positive('memory.entity.relationRetrieval.maxEdges must be a positive integer')
      .default(40),
    neighborScoreMultiplier: z
      .number({ error: 'memory.entity.relationRetrieval.neighborScoreMultiplier must be a number' })
      .gt(0, 'memory.entity.relationRetrieval.neighborScoreMultiplier must be > 0')
      .lte(1, 'memory.entity.relationRetrieval.neighborScoreMultiplier must be <= 1')
      .default(0.7),
    maxDepth: z
      .number({ error: 'memory.entity.relationRetrieval.maxDepth must be a number' })
      .int('memory.entity.relationRetrieval.maxDepth must be an integer')
      .positive('memory.entity.relationRetrieval.maxDepth must be a positive integer')
      .default(3),
    depthDecay: z
      .boolean({ error: 'memory.entity.relationRetrieval.depthDecay must be a boolean' })
      .default(true),
  }).default({
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
    .boolean({ error: 'memory.conflicts.enabled must be a boolean' })
    .default(true),
  gateMode: z
    .enum(['soft'], { error: 'memory.conflicts.gateMode must be "soft"' })
    .default('soft'),
  reaskCooldownTurns: z
    .number({ error: 'memory.conflicts.reaskCooldownTurns must be a number' })
    .int('memory.conflicts.reaskCooldownTurns must be an integer')
    .positive('memory.conflicts.reaskCooldownTurns must be a positive integer')
    .default(3),
  resolverLlmTimeoutMs: z
    .number({ error: 'memory.conflicts.resolverLlmTimeoutMs must be a number' })
    .int('memory.conflicts.resolverLlmTimeoutMs must be an integer')
    .positive('memory.conflicts.resolverLlmTimeoutMs must be a positive integer')
    .default(12000),
  relevanceThreshold: z
    .number({ error: 'memory.conflicts.relevanceThreshold must be a number' })
    .min(0, 'memory.conflicts.relevanceThreshold must be >= 0')
    .max(1, 'memory.conflicts.relevanceThreshold must be <= 1')
    .default(0.3),
  askOnIrrelevantTurns: z
    .boolean({ error: 'memory.conflicts.askOnIrrelevantTurns must be a boolean' })
    .default(false),
  conflictableKinds: z
    .array(
      z.enum(VALID_MEMORY_ITEM_KINDS, {
        error: `memory.conflicts.conflictableKinds entries must be one of: ${VALID_MEMORY_ITEM_KINDS.join(', ')}`,
      }),
    )
    .nonempty({ message: 'memory.conflicts.conflictableKinds must not be empty' })
    .default([...DEFAULT_CONFLICTABLE_KINDS]),
});

export const MemoryProfileConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.profile.enabled must be a boolean' })
    .default(true),
  maxInjectTokens: z
    .number({ error: 'memory.profile.maxInjectTokens must be a number' })
    .int('memory.profile.maxInjectTokens must be an integer')
    .positive('memory.profile.maxInjectTokens must be a positive integer')
    .default(800),
});

export const MemorySummarizationConfigSchema = z.object({
  useLLM: z
    .boolean({ error: 'memory.summarization.useLLM must be a boolean' })
    .default(true),
  modelIntent: z
    .enum(['latency-optimized', 'quality-optimized', 'vision-optimized'], {
      error: 'memory.summarization.modelIntent must be a valid model intent',
    })
    .default('latency-optimized'),
});

export const MemoryConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.enabled must be a boolean' })
    .default(true),
  embeddings: MemoryEmbeddingsConfigSchema.default({
    required: true,
    provider: 'auto',
    localModel: 'Xenova/bge-small-en-v1.5',
    openaiModel: 'text-embedding-3-small',
    geminiModel: 'gemini-embedding-001',
    ollamaModel: 'nomic-embed-text',
  }),
  qdrant: QdrantConfigSchema.default({
    url: 'http://127.0.0.1:6333',
    collection: 'memory',
    vectorSize: 384,
    onDisk: true,
    quantization: 'scalar',
  }),
  retrieval: MemoryRetrievalConfigSchema.default({
    lexicalTopK: 80,
    semanticTopK: 40,
    maxInjectTokens: 10000,
    injectionFormat: 'markdown',
    injectionStrategy: 'prepend_user_block',
    reranking: {
      enabled: false,
      modelIntent: 'latency-optimized',
      topK: 20,
    },
    freshness: {
      enabled: true,
      maxAgeDays: { fact: 0, preference: 0, behavior: 90, event: 30, opinion: 60 },
      staleDecay: 0.5,
      reinforcementShieldDays: 7,
    },
    scopePolicy: 'allow_global_fallback',
    dynamicBudget: {
      enabled: true,
      minInjectTokens: 1200,
      maxInjectTokens: 10000,
      targetHeadroomTokens: 10000,
    },
    earlyTermination: {
      enabled: true,
      minCandidates: 20,
      minHighConfidence: 10,
      confidenceThreshold: 0.7,
    },
  }),
  segmentation: MemorySegmentationConfigSchema.default({
    targetTokens: 450,
    overlapTokens: 60,
  }),
  jobs: MemoryJobsConfigSchema.default({
    workerConcurrency: 2,
    batchSize: 10,
  }),
  retention: MemoryRetentionConfigSchema.default({
    keepRawForever: true,
  }),
  cleanup: MemoryCleanupConfigSchema.default({
    enabled: true,
    enqueueIntervalMs: 6 * 60 * 60 * 1000,
    resolvedConflictRetentionMs: 30 * 24 * 60 * 60 * 1000,
    supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
    conversationRetentionDays: 90,
  }),
  extraction: MemoryExtractionConfigSchema.default({
    useLLM: true,
    modelIntent: 'latency-optimized',
    extractFromAssistant: true,
  }),
  summarization: MemorySummarizationConfigSchema.default({
    useLLM: true,
    modelIntent: 'latency-optimized',
  }),
  entity: MemoryEntityConfigSchema.default({
    enabled: true,
    modelIntent: 'latency-optimized',
    extractRelations: {
      enabled: true,
      backfillBatchSize: 200,
    },
    relationRetrieval: {
      enabled: true,
      maxSeedEntities: 8,
      maxNeighborEntities: 20,
      maxEdges: 40,
      neighborScoreMultiplier: 0.7,
      maxDepth: 3,
      depthDecay: true,
    },
  }),
  conflicts: MemoryConflictsConfigSchema.default({
    enabled: true,
    gateMode: 'soft',
    reaskCooldownTurns: 3,
    resolverLlmTimeoutMs: 12000,
    relevanceThreshold: 0.3,
    askOnIrrelevantTurns: false,
    conflictableKinds: ['preference', 'profile', 'constraint', 'instruction', 'style'],
  }),
  profile: MemoryProfileConfigSchema.default({
    enabled: true,
    maxInjectTokens: 800,
  }),
});

export type MemoryEmbeddingsConfig = z.infer<typeof MemoryEmbeddingsConfigSchema>;
export type MemoryRerankingConfig = z.infer<typeof MemoryRerankingConfigSchema>;
export type MemoryRetrievalConfig = z.infer<typeof MemoryRetrievalConfigSchema>;
export type MemorySegmentationConfig = z.infer<typeof MemorySegmentationConfigSchema>;
export type MemoryJobsConfig = z.infer<typeof MemoryJobsConfigSchema>;
export type MemoryRetentionConfig = z.infer<typeof MemoryRetentionConfigSchema>;
export type MemoryCleanupConfig = z.infer<typeof MemoryCleanupConfigSchema>;
export type MemoryExtractionConfig = z.infer<typeof MemoryExtractionConfigSchema>;
export type MemorySummarizationConfig = z.infer<typeof MemorySummarizationConfigSchema>;
export type MemoryEntityConfig = z.infer<typeof MemoryEntityConfigSchema>;
export type MemoryConflictsConfig = z.infer<typeof MemoryConflictsConfigSchema>;
export type MemoryProfileConfig = z.infer<typeof MemoryProfileConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
