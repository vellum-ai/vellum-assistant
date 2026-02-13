import { z } from 'zod';
import { getDataDir } from '../util/platform.js';

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama'] as const;
const VALID_SECRET_ACTIONS = ['redact', 'warn', 'block'] as const;
const VALID_MEMORY_EMBEDDING_PROVIDERS = ['auto', 'local', 'openai', 'gemini', 'ollama'] as const;

export const TimeoutConfigSchema = z.object({
  shellMaxTimeoutSec: z
    .number({ error: 'timeouts.shellMaxTimeoutSec must be a number' })
    .finite('timeouts.shellMaxTimeoutSec must be finite')
    .positive('timeouts.shellMaxTimeoutSec must be a positive number')
    .default(600),
  shellDefaultTimeoutSec: z
    .number({ error: 'timeouts.shellDefaultTimeoutSec must be a number' })
    .finite('timeouts.shellDefaultTimeoutSec must be finite')
    .positive('timeouts.shellDefaultTimeoutSec must be a positive number')
    .default(120),
  permissionTimeoutSec: z
    .number({ error: 'timeouts.permissionTimeoutSec must be a number' })
    .finite('timeouts.permissionTimeoutSec must be finite')
    .positive('timeouts.permissionTimeoutSec must be a positive number')
    .default(300),
});

export const SandboxConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'sandbox.enabled must be a boolean' })
    .default(false),
});

export const RateLimitConfigSchema = z.object({
  maxRequestsPerMinute: z
    .number({ error: 'rateLimit.maxRequestsPerMinute must be a number' })
    .int('rateLimit.maxRequestsPerMinute must be an integer')
    .nonnegative('rateLimit.maxRequestsPerMinute must be a non-negative integer')
    .default(0),
  maxTokensPerSession: z
    .number({ error: 'rateLimit.maxTokensPerSession must be a number' })
    .int('rateLimit.maxTokensPerSession must be an integer')
    .nonnegative('rateLimit.maxTokensPerSession must be a non-negative integer')
    .default(0),
});

export const SecretDetectionConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'secretDetection.enabled must be a boolean' })
    .default(true),
  action: z
    .enum(VALID_SECRET_ACTIONS, {
      error: `secretDetection.action must be one of: ${VALID_SECRET_ACTIONS.join(', ')}`,
    })
    .default('warn'),
  entropyThreshold: z
    .number({ error: 'secretDetection.entropyThreshold must be a number' })
    .finite('secretDetection.entropyThreshold must be finite')
    .positive('secretDetection.entropyThreshold must be a positive number')
    .default(4.0),
});

export const AuditLogConfigSchema = z.object({
  retentionDays: z
    .number({ error: 'auditLog.retentionDays must be a number' })
    .int('auditLog.retentionDays must be an integer')
    .nonnegative('auditLog.retentionDays must be a non-negative integer')
    .default(0),
});

export const ThinkingConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'thinking.enabled must be a boolean' })
    .default(false),
  budgetTokens: z
    .number({ error: 'thinking.budgetTokens must be a number' })
    .int('thinking.budgetTokens must be an integer')
    .positive('thinking.budgetTokens must be a positive integer')
    .default(10000),
});

export const ContextWindowConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'contextWindow.enabled must be a boolean' })
    .default(true),
  maxInputTokens: z
    .number({ error: 'contextWindow.maxInputTokens must be a number' })
    .int('contextWindow.maxInputTokens must be an integer')
    .positive('contextWindow.maxInputTokens must be a positive integer')
    .default(180000),
  targetInputTokens: z
    .number({ error: 'contextWindow.targetInputTokens must be a number' })
    .int('contextWindow.targetInputTokens must be an integer')
    .positive('contextWindow.targetInputTokens must be a positive integer')
    .default(110000),
  compactThreshold: z
    .number({ error: 'contextWindow.compactThreshold must be a number' })
    .finite('contextWindow.compactThreshold must be finite')
    .gt(0, 'contextWindow.compactThreshold must be greater than 0')
    .lte(1, 'contextWindow.compactThreshold must be less than or equal to 1')
    .default(0.8),
  preserveRecentUserTurns: z
    .number({ error: 'contextWindow.preserveRecentUserTurns must be a number' })
    .int('contextWindow.preserveRecentUserTurns must be an integer')
    .positive('contextWindow.preserveRecentUserTurns must be a positive integer')
    .default(8),
  summaryMaxTokens: z
    .number({ error: 'contextWindow.summaryMaxTokens must be a number' })
    .int('contextWindow.summaryMaxTokens must be an integer')
    .positive('contextWindow.summaryMaxTokens must be a positive integer')
    .default(1200),
  chunkTokens: z
    .number({ error: 'contextWindow.chunkTokens must be a number' })
    .int('contextWindow.chunkTokens must be an integer')
    .positive('contextWindow.chunkTokens must be a positive integer')
    .default(12000),
});

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

const VALID_QDRANT_QUANTIZATION = ['scalar', 'none'] as const;

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
    .default(true),
  model: z
    .string({ error: 'memory.retrieval.reranking.model must be a string' })
    .default('claude-haiku-4-5-20251001'),
  topK: z
    .number({ error: 'memory.retrieval.reranking.topK must be a number' })
    .int('memory.retrieval.reranking.topK must be an integer')
    .positive('memory.retrieval.reranking.topK must be a positive integer')
    .default(20),
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
  reranking: MemoryRerankingConfigSchema.default({
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
    topK: 20,
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
});

export const MemoryRetentionConfigSchema = z.object({
  keepRawForever: z
    .boolean({ error: 'memory.retention.keepRawForever must be a boolean' })
    .default(true),
});

export const MemoryExtractionConfigSchema = z.object({
  useLLM: z
    .boolean({ error: 'memory.extraction.useLLM must be a boolean' })
    .default(true),
  model: z
    .string({ error: 'memory.extraction.model must be a string' })
    .default('claude-haiku-4-5-20251001'),
  extractFromAssistant: z
    .boolean({ error: 'memory.extraction.extractFromAssistant must be a boolean' })
    .default(true),
});

export const MemoryEntityConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.entity.enabled must be a boolean' })
    .default(true),
  model: z
    .string({ error: 'memory.entity.model must be a string' })
    .default('claude-haiku-4-5-20251001'),
});

export const MemorySummarizationConfigSchema = z.object({
  useLLM: z
    .boolean({ error: 'memory.summarization.useLLM must be a boolean' })
    .default(true),
  model: z
    .string({ error: 'memory.summarization.model must be a string' })
    .default('claude-haiku-4-5-20251001'),
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
    reranking: {
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
      topK: 20,
    },
  }),
  segmentation: MemorySegmentationConfigSchema.default({
    targetTokens: 450,
    overlapTokens: 60,
  }),
  jobs: MemoryJobsConfigSchema.default({
    workerConcurrency: 2,
  }),
  retention: MemoryRetentionConfigSchema.default({
    keepRawForever: true,
  }),
  extraction: MemoryExtractionConfigSchema.default({
    useLLM: true,
    model: 'claude-haiku-4-5-20251001',
    extractFromAssistant: true,
  }),
  summarization: MemorySummarizationConfigSchema.default({
    useLLM: true,
    model: 'claude-haiku-4-5-20251001',
  }),
  entity: MemoryEntityConfigSchema.default({
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
  }),
});

export const ModelPricingOverrideSchema = z.object({
  provider: z.string({ error: 'pricingOverrides[].provider must be a string' }),
  modelPattern: z.string({ error: 'pricingOverrides[].modelPattern must be a string' }),
  inputPer1M: z
    .number({ error: 'pricingOverrides[].inputPer1M must be a number' })
    .nonnegative('pricingOverrides[].inputPer1M must be a non-negative number'),
  outputPer1M: z
    .number({ error: 'pricingOverrides[].outputPer1M must be a number' })
    .nonnegative('pricingOverrides[].outputPer1M must be a non-negative number'),
});

export const AssistantConfigSchema = z.object({
  provider: z
    .enum(VALID_PROVIDERS, {
      error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
    })
    .default('anthropic'),
  model: z
    .string({ error: 'model must be a string' })
    .default('claude-opus-4-6'),
  apiKeys: z
    .record(z.string(), z.string({ error: 'Each apiKeys value must be a string' }))
    .default({}),
  systemPrompt: z
    .string({ error: 'systemPrompt must be a string' })
    .optional(),
  maxTokens: z
    .number({ error: 'maxTokens must be a number' })
    .int('maxTokens must be an integer')
    .positive('maxTokens must be a positive integer')
    .default(64000),
  thinking: ThinkingConfigSchema.default({
    enabled: false,
    budgetTokens: 10000,
  }),
  contextWindow: ContextWindowConfigSchema.default({
    enabled: true,
    maxInputTokens: 180000,
    targetInputTokens: 110000,
    compactThreshold: 0.8,
    preserveRecentUserTurns: 8,
    summaryMaxTokens: 1200,
    chunkTokens: 12000,
  }),
  memory: MemoryConfigSchema.default({
    enabled: true,
    embeddings: {
      required: true,
      provider: 'auto',
      localModel: 'Xenova/bge-small-en-v1.5',
      openaiModel: 'text-embedding-3-small',
      geminiModel: 'gemini-embedding-001',
      ollamaModel: 'nomic-embed-text',
    },
    qdrant: {
      url: 'http://127.0.0.1:6333',
      collection: 'memory',
      vectorSize: 384,
      onDisk: true,
      quantization: 'scalar',
    },
    retrieval: {
      lexicalTopK: 80,
      semanticTopK: 40,
      maxInjectTokens: 10000,
      reranking: {
        enabled: true,
        model: 'claude-haiku-4-5-20251001',
        topK: 20,
      },
    },
    segmentation: {
      targetTokens: 450,
      overlapTokens: 60,
    },
    jobs: {
      workerConcurrency: 2,
    },
    retention: {
      keepRawForever: true,
    },
    extraction: {
      useLLM: true,
      model: 'claude-haiku-4-5-20251001',
      extractFromAssistant: true,
    },
    summarization: {
      useLLM: true,
      model: 'claude-haiku-4-5-20251001',
    },
    entity: {
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
    },
  }),
  dataDir: z
    .string({ error: 'dataDir must be a string' })
    .default(getDataDir()),
  timeouts: TimeoutConfigSchema.default({
    shellMaxTimeoutSec: 600,
    shellDefaultTimeoutSec: 120,
    permissionTimeoutSec: 300,
  }),
  sandbox: SandboxConfigSchema.default({
    enabled: false,
  }),
  rateLimit: RateLimitConfigSchema.default({
    maxRequestsPerMinute: 0,
    maxTokensPerSession: 0,
  }),
  secretDetection: SecretDetectionConfigSchema.default({
    enabled: true,
    action: 'warn',
    entropyThreshold: 4.0,
  }),
  auditLog: AuditLogConfigSchema.default({
    retentionDays: 0,
  }),
  pricingOverrides: z
    .array(ModelPricingOverrideSchema)
    .default([]),
}).superRefine((config, ctx) => {
  if (config.contextWindow.targetInputTokens >= config.contextWindow.maxInputTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contextWindow', 'targetInputTokens'],
      message: 'contextWindow.targetInputTokens must be less than contextWindow.maxInputTokens',
    });
  }
  if (config.memory.segmentation.overlapTokens >= config.memory.segmentation.targetTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memory', 'segmentation', 'overlapTokens'],
      message: 'memory.segmentation.overlapTokens must be less than memory.segmentation.targetTokens',
    });
  }
});

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type ContextWindowConfig = z.infer<typeof ContextWindowConfigSchema>;
export type MemoryEmbeddingsConfig = z.infer<typeof MemoryEmbeddingsConfigSchema>;
export type MemoryRerankingConfig = z.infer<typeof MemoryRerankingConfigSchema>;
export type MemoryRetrievalConfig = z.infer<typeof MemoryRetrievalConfigSchema>;
export type MemorySegmentationConfig = z.infer<typeof MemorySegmentationConfigSchema>;
export type MemoryJobsConfig = z.infer<typeof MemoryJobsConfigSchema>;
export type MemoryRetentionConfig = z.infer<typeof MemoryRetentionConfigSchema>;
export type MemoryExtractionConfig = z.infer<typeof MemoryExtractionConfigSchema>;
export type MemorySummarizationConfig = z.infer<typeof MemorySummarizationConfigSchema>;
export type MemoryEntityConfig = z.infer<typeof MemoryEntityConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type QdrantConfig = z.infer<typeof QdrantConfigSchema>;
export type ModelPricingOverride = z.infer<typeof ModelPricingOverrideSchema>;
