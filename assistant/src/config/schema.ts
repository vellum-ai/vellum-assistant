import { z } from 'zod';
import { getDataDir } from '../util/platform.js';

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'fireworks'] as const;
const VALID_SECRET_ACTIONS = ['redact', 'warn', 'block'] as const;
const VALID_MEMORY_EMBEDDING_PROVIDERS = ['auto', 'local', 'openai', 'gemini', 'ollama'] as const;
const VALID_SANDBOX_BACKENDS = ['native', 'docker'] as const;
const VALID_DOCKER_NETWORKS = ['none', 'bridge'] as const;

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

export const DockerConfigSchema = z.object({
  image: z
    .string({ error: 'sandbox.docker.image must be a string' })
    .default('node:20-slim@sha256:c6585df72c34172bebd8d36abed961e231d7d3b5cee2e01294c4495e8a03f687'),
  shell: z
    .string({ error: 'sandbox.docker.shell must be a string' })
    .default('sh'),
  cpus: z
    .number({ error: 'sandbox.docker.cpus must be a number' })
    .finite('sandbox.docker.cpus must be finite')
    .positive('sandbox.docker.cpus must be a positive number')
    .default(1),
  memoryMb: z
    .number({ error: 'sandbox.docker.memoryMb must be a number' })
    .int('sandbox.docker.memoryMb must be an integer')
    .positive('sandbox.docker.memoryMb must be a positive integer')
    .default(512),
  pidsLimit: z
    .number({ error: 'sandbox.docker.pidsLimit must be a number' })
    .int('sandbox.docker.pidsLimit must be an integer')
    .positive('sandbox.docker.pidsLimit must be a positive integer')
    .default(256),
  network: z
    .enum(VALID_DOCKER_NETWORKS, {
      error: `sandbox.docker.network must be one of: ${VALID_DOCKER_NETWORKS.join(', ')}`,
    })
    .default('none'),
});

export const SandboxConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'sandbox.enabled must be a boolean' })
    .default(true),
  backend: z
    .enum(VALID_SANDBOX_BACKENDS, {
      error: `sandbox.backend must be one of: ${VALID_SANDBOX_BACKENDS.join(', ')}`,
    })
    .default('docker'),
  docker: DockerConfigSchema.default({
    image: 'node:20-slim@sha256:c6585df72c34172bebd8d36abed961e231d7d3b5cee2e01294c4495e8a03f687',
    shell: 'sh',
    cpus: 1,
    memoryMb: 512,
    pidsLimit: 256,
    network: 'none',
  }),
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

export const MemoryDynamicBudgetConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'memory.retrieval.dynamicBudget.enabled must be a boolean' })
    .default(false),
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
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
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
    enabled: false,
    minInjectTokens: 1200,
    maxInjectTokens: 10000,
    targetHeadroomTokens: 10000,
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
  extractRelations: z.object({
    enabled: z
      .boolean({ error: 'memory.entity.extractRelations.enabled must be a boolean' })
      .default(false),
  }).default({
    enabled: false,
  }),
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
    injectionFormat: 'markdown',
    injectionStrategy: 'prepend_user_block',
    reranking: {
      enabled: true,
      model: 'claude-haiku-4-5-20251001',
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
      enabled: false,
      minInjectTokens: 1200,
      maxInjectTokens: 10000,
      targetHeadroomTokens: 10000,
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
    extractRelations: {
      enabled: false,
    },
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

export const SkillEntryConfigSchema = z.object({
  enabled: z.boolean({ error: 'skills.entries[].enabled must be a boolean' }).default(true),
  apiKey: z.string({ error: 'skills.entries[].apiKey must be a string' }).optional(),
  env: z.record(z.string(), z.string({ error: 'skills.entries[].env values must be strings' })).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const SkillsLoadConfigSchema = z.object({
  extraDirs: z.array(z.string({ error: 'skills.load.extraDirs values must be strings' })).default([]),
  watch: z.boolean({ error: 'skills.load.watch must be a boolean' }).default(true),
  watchDebounceMs: z.number({ error: 'skills.load.watchDebounceMs must be a number' }).int().positive().default(250),
});

export const SkillsInstallConfigSchema = z.object({
  nodeManager: z.enum(['npm', 'pnpm', 'yarn', 'bun'], {
    error: 'skills.install.nodeManager must be one of: npm, pnpm, yarn, bun',
  }).default('npm'),
});

export const SkillsConfigSchema = z.object({
  entries: z.record(z.string(), SkillEntryConfigSchema).default({}),
  load: SkillsLoadConfigSchema.default({ extraDirs: [], watch: true, watchDebounceMs: 250 }),
  install: SkillsInstallConfigSchema.default({ nodeManager: 'npm' }),
  allowBundled: z.array(z.string()).nullable().default(null),
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
      injectionFormat: 'markdown',
      injectionStrategy: 'prepend_user_block',
      reranking: {
        enabled: true,
        model: 'claude-haiku-4-5-20251001',
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
        enabled: false,
        minInjectTokens: 1200,
        maxInjectTokens: 10000,
        targetHeadroomTokens: 10000,
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
      extractRelations: {
        enabled: false,
      },
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
    enabled: true,
    backend: 'docker',
    docker: {
      image: 'node:20-slim@sha256:c6585df72c34172bebd8d36abed961e231d7d3b5cee2e01294c4495e8a03f687',
      shell: 'sh',
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: 'none',
    },
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
  skills: SkillsConfigSchema.default({
    entries: {},
    load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
    install: { nodeManager: 'npm' },
    allowBundled: null,
  }),
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
  if (config.memory.retrieval.dynamicBudget.minInjectTokens > config.memory.retrieval.dynamicBudget.maxInjectTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memory', 'retrieval', 'dynamicBudget'],
      message: 'memory.retrieval.dynamicBudget.minInjectTokens must be <= memory.retrieval.dynamicBudget.maxInjectTokens',
    });
  }
});

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
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
export type SkillEntryConfig = z.infer<typeof SkillEntryConfigSchema>;
export type SkillsLoadConfig = z.infer<typeof SkillsLoadConfigSchema>;
export type SkillsInstallConfig = z.infer<typeof SkillsInstallConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
