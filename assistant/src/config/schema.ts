import { z } from 'zod';
import { getDataDir } from '../util/platform.js';

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'fireworks', 'openrouter'] as const;
const VALID_WEB_SEARCH_PROVIDERS = ['perplexity', 'brave', 'anthropic-native'] as const;
const VALID_SECRET_ACTIONS = ['redact', 'warn', 'block', 'prompt'] as const;
const VALID_MEMORY_EMBEDDING_PROVIDERS = ['auto', 'local', 'openai', 'gemini', 'ollama'] as const;
const VALID_SANDBOX_BACKENDS = ['native', 'docker'] as const;
const VALID_DOCKER_NETWORKS = ['none', 'bridge'] as const;
const VALID_PERMISSIONS_MODES = ['legacy', 'strict', 'workspace'] as const;
const VALID_SMS_PROVIDERS = ['twilio'] as const;
const VALID_CALL_PROVIDERS = ['twilio'] as const;
const VALID_CALL_VOICE_MODES = ['twilio_standard', 'twilio_elevenlabs_tts', 'elevenlabs_agent'] as const;
export const VALID_CALLER_IDENTITY_MODES = ['assistant_number', 'user_number'] as const;
const VALID_CALL_TRANSCRIPTION_PROVIDERS = ['Deepgram', 'Google'] as const;
const VALID_MEMORY_ITEM_KINDS = [
  'preference', 'profile', 'project', 'decision', 'todo',
  'fact', 'constraint', 'relationship', 'event', 'opinion', 'instruction', 'style',
] as const;

const DEFAULT_CONFLICTABLE_KINDS = [
  'preference', 'profile', 'constraint', 'instruction', 'style',
] as const;

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
  toolExecutionTimeoutSec: z
    .number({ error: 'timeouts.toolExecutionTimeoutSec must be a number' })
    .finite('timeouts.toolExecutionTimeoutSec must be finite')
    .positive('timeouts.toolExecutionTimeoutSec must be a positive number')
    .default(120),
  providerStreamTimeoutSec: z
    .number({ error: 'timeouts.providerStreamTimeoutSec must be a number' })
    .finite('timeouts.providerStreamTimeoutSec must be finite')
    .positive('timeouts.providerStreamTimeoutSec must be a positive number')
    .default(300),
});

export const DockerConfigSchema = z.object({
  image: z
    .string({ error: 'sandbox.docker.image must be a string' })
    .default('vellum-sandbox:latest'),
  shell: z
    .string({ error: 'sandbox.docker.shell must be a string' })
    .default('bash'),
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
    image: 'vellum-sandbox:latest',
    shell: 'bash',
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
    .default('redact'),
  entropyThreshold: z
    .number({ error: 'secretDetection.entropyThreshold must be a number' })
    .finite('secretDetection.entropyThreshold must be finite')
    .positive('secretDetection.entropyThreshold must be a positive number')
    .default(4.0),
  allowOneTimeSend: z
    .boolean({ error: 'secretDetection.allowOneTimeSend must be a boolean' })
    .default(false),
  blockIngress: z
    .boolean({ error: 'secretDetection.blockIngress must be a boolean' })
    .default(true),
});

export const PermissionsConfigSchema = z.object({
  mode: z
    .enum(VALID_PERMISSIONS_MODES, {
      error: `permissions.mode must be one of: ${VALID_PERMISSIONS_MODES.join(', ')}`,
    })
    .default('workspace'),
});

export const AuditLogConfigSchema = z.object({
  retentionDays: z
    .number({ error: 'auditLog.retentionDays must be a number' })
    .int('auditLog.retentionDays must be an integer')
    .nonnegative('auditLog.retentionDays must be a non-negative integer')
    .default(0),
});

export const LogFileConfigSchema = z.object({
  dir: z
    .string({ error: 'logFile.dir must be a string' })
    .optional(),
  retentionDays: z
    .number({ error: 'logFile.retentionDays must be a number' })
    .int('logFile.retentionDays must be an integer')
    .positive('logFile.retentionDays must be a positive integer')
    .default(30),
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

export const WorkspaceGitConfigSchema = z.object({
  turnCommitMaxWaitMs: z
    .number({ error: 'workspaceGit.turnCommitMaxWaitMs must be a number' })
    .int('workspaceGit.turnCommitMaxWaitMs must be an integer')
    .positive('workspaceGit.turnCommitMaxWaitMs must be a positive integer')
    .default(4000),
  failureBackoffBaseMs: z
    .number({ error: 'workspaceGit.failureBackoffBaseMs must be a number' })
    .int('workspaceGit.failureBackoffBaseMs must be an integer')
    .positive('workspaceGit.failureBackoffBaseMs must be a positive integer')
    .default(2000),
  failureBackoffMaxMs: z
    .number({ error: 'workspaceGit.failureBackoffMaxMs must be a number' })
    .int('workspaceGit.failureBackoffMaxMs must be an integer')
    .positive('workspaceGit.failureBackoffMaxMs must be a positive integer')
    .default(60000),
  interactiveGitTimeoutMs: z
    .number({ error: 'workspaceGit.interactiveGitTimeoutMs must be a number' })
    .int('workspaceGit.interactiveGitTimeoutMs must be an integer')
    .positive('workspaceGit.interactiveGitTimeoutMs must be a positive integer')
    .default(10000),
  enrichmentQueueSize: z
    .number({ error: 'workspaceGit.enrichmentQueueSize must be a number' })
    .int('workspaceGit.enrichmentQueueSize must be an integer')
    .positive('workspaceGit.enrichmentQueueSize must be a positive integer')
    .default(50),
  enrichmentConcurrency: z
    .number({ error: 'workspaceGit.enrichmentConcurrency must be a number' })
    .int('workspaceGit.enrichmentConcurrency must be an integer')
    .positive('workspaceGit.enrichmentConcurrency must be a positive integer')
    .default(1),
  enrichmentJobTimeoutMs: z
    .number({ error: 'workspaceGit.enrichmentJobTimeoutMs must be a number' })
    .int('workspaceGit.enrichmentJobTimeoutMs must be an integer')
    .positive('workspaceGit.enrichmentJobTimeoutMs must be a positive integer')
    .default(30000),
  enrichmentMaxRetries: z
    .number({ error: 'workspaceGit.enrichmentMaxRetries must be a number' })
    .int('workspaceGit.enrichmentMaxRetries must be an integer')
    .nonnegative('workspaceGit.enrichmentMaxRetries must be non-negative')
    .default(2),
  commitMessageLLM: z.object({
    enabled: z.boolean({ error: 'workspaceGit.commitMessageLLM.enabled must be a boolean' }).default(false),
    useConfiguredProvider: z.boolean({ error: 'workspaceGit.commitMessageLLM.useConfiguredProvider must be a boolean' }).default(true),
    providerFastModelOverrides: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number({ error: 'workspaceGit.commitMessageLLM.timeoutMs must be a number' })
      .int('workspaceGit.commitMessageLLM.timeoutMs must be an integer')
      .positive('workspaceGit.commitMessageLLM.timeoutMs must be a positive integer')
      .default(600),
    maxTokens: z.number({ error: 'workspaceGit.commitMessageLLM.maxTokens must be a number' })
      .int('workspaceGit.commitMessageLLM.maxTokens must be an integer')
      .positive('workspaceGit.commitMessageLLM.maxTokens must be a positive integer')
      .default(120),
    temperature: z.number({ error: 'workspaceGit.commitMessageLLM.temperature must be a number' })
      .min(0, 'workspaceGit.commitMessageLLM.temperature must be >= 0')
      .max(2, 'workspaceGit.commitMessageLLM.temperature must be <= 2')
      .default(0.2),
    maxFilesInPrompt: z.number({ error: 'workspaceGit.commitMessageLLM.maxFilesInPrompt must be a number' })
      .int('workspaceGit.commitMessageLLM.maxFilesInPrompt must be an integer')
      .positive('workspaceGit.commitMessageLLM.maxFilesInPrompt must be a positive integer')
      .default(30),
    maxDiffBytes: z.number({ error: 'workspaceGit.commitMessageLLM.maxDiffBytes must be a number' })
      .int('workspaceGit.commitMessageLLM.maxDiffBytes must be an integer')
      .positive('workspaceGit.commitMessageLLM.maxDiffBytes must be a positive integer')
      .default(12000),
    minRemainingTurnBudgetMs: z.number({ error: 'workspaceGit.commitMessageLLM.minRemainingTurnBudgetMs must be a number' })
      .int('workspaceGit.commitMessageLLM.minRemainingTurnBudgetMs must be an integer')
      .nonnegative('workspaceGit.commitMessageLLM.minRemainingTurnBudgetMs must be non-negative')
      .default(1000),
    breaker: z.object({
      openAfterFailures: z.number({ error: 'workspaceGit.commitMessageLLM.breaker.openAfterFailures must be a number' })
        .int().positive().default(3),
      backoffBaseMs: z.number({ error: 'workspaceGit.commitMessageLLM.breaker.backoffBaseMs must be a number' })
        .int().positive().default(2000),
      backoffMaxMs: z.number({ error: 'workspaceGit.commitMessageLLM.breaker.backoffMaxMs must be a number' })
        .int().positive().default(60000),
    }).default({ openAfterFailures: 3, backoffBaseMs: 2000, backoffMaxMs: 60000 }),
  }).default({
    enabled: false,
    useConfiguredProvider: true,
    providerFastModelOverrides: {},
    timeoutMs: 600,
    maxTokens: 120,
    temperature: 0.2,
    maxFilesInPrompt: 30,
    maxDiffBytes: 12000,
    minRemainingTurnBudgetMs: 1000,
    breaker: { openAfterFailures: 3, backoffBaseMs: 2000, backoffMaxMs: 60000 },
  }),
});

export const AgentHeartbeatConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'agentHeartbeat.enabled must be a boolean' })
    .default(false),
  intervalMs: z
    .number({ error: 'agentHeartbeat.intervalMs must be a number' })
    .int('agentHeartbeat.intervalMs must be an integer')
    .positive('agentHeartbeat.intervalMs must be a positive integer')
    .default(3_600_000),
  activeHoursStart: z
    .number({ error: 'agentHeartbeat.activeHoursStart must be a number' })
    .int('agentHeartbeat.activeHoursStart must be an integer')
    .min(0, 'agentHeartbeat.activeHoursStart must be >= 0')
    .max(23, 'agentHeartbeat.activeHoursStart must be <= 23')
    .optional(),
  activeHoursEnd: z
    .number({ error: 'agentHeartbeat.activeHoursEnd must be a number' })
    .int('agentHeartbeat.activeHoursEnd must be an integer')
    .min(0, 'agentHeartbeat.activeHoursEnd must be >= 0')
    .max(23, 'agentHeartbeat.activeHoursEnd must be <= 23')
    .optional(),
}).superRefine((config, ctx) => {
  const hasStart = config.activeHoursStart != null;
  const hasEnd = config.activeHoursEnd != null;
  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasStart ? 'activeHoursEnd' : 'activeHoursStart'],
      message: 'agentHeartbeat.activeHoursStart and agentHeartbeat.activeHoursEnd must both be set or both be omitted',
    });
  }
  if (hasStart && hasEnd && config.activeHoursStart === config.activeHoursEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activeHoursEnd'],
      message: 'agentHeartbeat.activeHoursStart and agentHeartbeat.activeHoursEnd must not be equal (would create an empty window)',
    });
  }
});

export const SwarmConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'swarm.enabled must be a boolean' })
    .default(true),
  maxWorkers: z
    .number({ error: 'swarm.maxWorkers must be a number' })
    .int('swarm.maxWorkers must be an integer')
    .positive('swarm.maxWorkers must be a positive integer')
    .max(6, 'swarm.maxWorkers must be at most 6')
    .default(3),
  maxTasks: z
    .number({ error: 'swarm.maxTasks must be a number' })
    .int('swarm.maxTasks must be an integer')
    .positive('swarm.maxTasks must be a positive integer')
    .max(20, 'swarm.maxTasks must be at most 20')
    .default(8),
  maxRetriesPerTask: z
    .number({ error: 'swarm.maxRetriesPerTask must be a number' })
    .int('swarm.maxRetriesPerTask must be an integer')
    .nonnegative('swarm.maxRetriesPerTask must be a non-negative integer')
    .max(3, 'swarm.maxRetriesPerTask must be at most 3')
    .default(1),
  workerTimeoutSec: z
    .number({ error: 'swarm.workerTimeoutSec must be a number' })
    .int('swarm.workerTimeoutSec must be an integer')
    .positive('swarm.workerTimeoutSec must be a positive integer')
    .default(900),
  plannerModel: z
    .string({ error: 'swarm.plannerModel must be a string' })
    .default('claude-haiku-4-5-20251001'),
  synthesizerModel: z
    .string({ error: 'swarm.synthesizerModel must be a string' })
    .default('claude-sonnet-4-6'),
});

export const CallsDisclosureConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'calls.disclosure.enabled must be a boolean' })
    .default(true),
  text: z
    .string({ error: 'calls.disclosure.text must be a string' })
    .default('At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".'),
});

export const CallsSafetyConfigSchema = z.object({
  denyCategories: z
    .array(z.string({ error: 'calls.safety.denyCategories values must be strings' }))
    .default([]),
});

export const CallsElevenLabsConfigSchema = z.object({
  voiceId: z
    .string({ error: 'calls.voice.elevenlabs.voiceId must be a string' })
    .default(''),
  voiceModelId: z
    .string({ error: 'calls.voice.elevenlabs.voiceModelId must be a string' })
    .default(''),
  speed: z
    .number({ error: 'calls.voice.elevenlabs.speed must be a number' })
    .min(0.7, 'calls.voice.elevenlabs.speed must be >= 0.7')
    .max(1.2, 'calls.voice.elevenlabs.speed must be <= 1.2')
    .default(1.0),
  stability: z
    .number({ error: 'calls.voice.elevenlabs.stability must be a number' })
    .min(0, 'calls.voice.elevenlabs.stability must be >= 0')
    .max(1, 'calls.voice.elevenlabs.stability must be <= 1')
    .default(0.5),
  similarityBoost: z
    .number({ error: 'calls.voice.elevenlabs.similarityBoost must be a number' })
    .min(0, 'calls.voice.elevenlabs.similarityBoost must be >= 0')
    .max(1, 'calls.voice.elevenlabs.similarityBoost must be <= 1')
    .default(0.75),
  useSpeakerBoost: z
    .boolean({ error: 'calls.voice.elevenlabs.useSpeakerBoost must be a boolean' })
    .default(true),
  agentId: z
    .string({ error: 'calls.voice.elevenlabs.agentId must be a string' })
    .default(''),
  apiBaseUrl: z
    .string({ error: 'calls.voice.elevenlabs.apiBaseUrl must be a string' })
    .default('https://api.elevenlabs.io'),
  registerCallTimeoutMs: z
    .number({ error: 'calls.voice.elevenlabs.registerCallTimeoutMs must be a number' })
    .int('calls.voice.elevenlabs.registerCallTimeoutMs must be an integer')
    .min(1000, 'calls.voice.elevenlabs.registerCallTimeoutMs must be >= 1000')
    .max(15000, 'calls.voice.elevenlabs.registerCallTimeoutMs must be <= 15000')
    .default(5000),
});

export const CallsVoiceConfigSchema = z.object({
  mode: z
    .enum(VALID_CALL_VOICE_MODES, {
      error: `calls.voice.mode must be one of: ${VALID_CALL_VOICE_MODES.join(', ')}`,
    })
    .default('twilio_standard'),
  language: z
    .string({ error: 'calls.voice.language must be a string' })
    .default('en-US'),
  transcriptionProvider: z
    .enum(VALID_CALL_TRANSCRIPTION_PROVIDERS, {
      error: `calls.voice.transcriptionProvider must be one of: ${VALID_CALL_TRANSCRIPTION_PROVIDERS.join(', ')}`,
    })
    .default('Deepgram'),
  fallbackToStandardOnError: z
    .boolean({ error: 'calls.voice.fallbackToStandardOnError must be a boolean' })
    .default(true),
  elevenlabs: CallsElevenLabsConfigSchema.default({
    voiceId: '',
    voiceModelId: '',
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.75,
    useSpeakerBoost: true,
    agentId: '',
    apiBaseUrl: 'https://api.elevenlabs.io',
    registerCallTimeoutMs: 5000,
  }),
});

export const CallerIdentityConfigSchema = z.object({
  allowPerCallOverride: z
    .boolean({ error: 'calls.callerIdentity.allowPerCallOverride must be a boolean' })
    .default(true),
  userNumber: z
    .string({ error: 'calls.callerIdentity.userNumber must be a string' })
    .optional(),
});

export const CallsVerificationConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'calls.verification.enabled must be a boolean' })
    .default(false),
  maxAttempts: z
    .number({ error: 'calls.verification.maxAttempts must be a number' })
    .int('calls.verification.maxAttempts must be an integer')
    .positive('calls.verification.maxAttempts must be a positive integer')
    .default(3),
  codeLength: z
    .number({ error: 'calls.verification.codeLength must be a number' })
    .int('calls.verification.codeLength must be an integer')
    .positive('calls.verification.codeLength must be a positive integer')
    .default(6),
});

export const CallsConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'calls.enabled must be a boolean' })
    .default(true),
  provider: z
    .enum(VALID_CALL_PROVIDERS, {
      error: `calls.provider must be one of: ${VALID_CALL_PROVIDERS.join(', ')}`,
    })
    .default('twilio'),
  maxDurationSeconds: z
    .number({ error: 'calls.maxDurationSeconds must be a number' })
    .int('calls.maxDurationSeconds must be an integer')
    .positive('calls.maxDurationSeconds must be a positive integer')
    .max(2_147_483, 'calls.maxDurationSeconds must be at most 2147483 (setTimeout-safe limit)')
    .default(3600),
  userConsultTimeoutSeconds: z
    .number({ error: 'calls.userConsultTimeoutSeconds must be a number' })
    .int('calls.userConsultTimeoutSeconds must be an integer')
    .positive('calls.userConsultTimeoutSeconds must be a positive integer')
    .max(2_147_483, 'calls.userConsultTimeoutSeconds must be at most 2147483 (setTimeout-safe limit)')
    .default(120),
  disclosure: CallsDisclosureConfigSchema.default({
    enabled: true,
    text: 'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
  }),
  safety: CallsSafetyConfigSchema.default({
    denyCategories: [],
  }),
  voice: CallsVoiceConfigSchema.default({
    mode: 'twilio_standard',
    language: 'en-US',
    transcriptionProvider: 'Deepgram',
    fallbackToStandardOnError: true,
    elevenlabs: {
      voiceId: '',
      voiceModelId: '',
      speed: 1.0,
      stability: 0.5,
      similarityBoost: 0.75,
      useSpeakerBoost: true,
      agentId: '',
      apiBaseUrl: 'https://api.elevenlabs.io',
      registerCallTimeoutMs: 5000,
    },
  }),
  model: z
    .string({ error: 'calls.model must be a string' })
    .optional(),
  callerIdentity: CallerIdentityConfigSchema.default({
    allowPerCallOverride: true,
  }),
  verification: CallsVerificationConfigSchema.default({
    enabled: false,
    maxAttempts: 3,
    codeLength: 6,
  }),
});

export const SkillsConfigSchema = z.object({
  entries: z.record(z.string(), SkillEntryConfigSchema).default({}),
  load: SkillsLoadConfigSchema.default({ extraDirs: [], watch: true, watchDebounceMs: 250 }),
  install: SkillsInstallConfigSchema.default({ nodeManager: 'npm' }),
  allowBundled: z.array(z.string()).nullable().default(null),
});

export const SmsConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'sms.enabled must be a boolean' })
    .default(false),
  provider: z
    .enum(VALID_SMS_PROVIDERS, {
      error: `sms.provider must be one of: ${VALID_SMS_PROVIDERS.join(', ')}`,
    })
    .default('twilio'),
  phoneNumber: z
    .string({ error: 'sms.phoneNumber must be a string' })
    .default(''),
  assistantPhoneNumbers: z
    .record(z.string(), z.string({ error: 'sms.assistantPhoneNumbers values must be strings' }))
    .optional(),
});

const IngressBaseSchema = z.object({
  enabled: z
    .boolean({ error: 'ingress.enabled must be a boolean' })
    .optional(),
  publicBaseUrl: z
    .string({ error: 'ingress.publicBaseUrl must be a string' })
    .default(''),
});

export const IngressConfigSchema = IngressBaseSchema
  .default({ publicBaseUrl: '' })
  .transform((val) => ({
    ...val,
    // Backward compatibility: if `enabled` was never explicitly set (undefined),
    // infer it from whether a publicBaseUrl is configured. Existing users who
    // have a URL but predate the `enabled` field should not have their webhooks
    // silently disabled on upgrade.
    //
    // When publicBaseUrl is empty and enabled is unset, leave enabled as
    // undefined so getPublicBaseUrl() can still fall through to the
    // INGRESS_PUBLIC_BASE_URL env-var fallback (env-only setups).
    enabled: val.enabled ?? (val.publicBaseUrl ? true : undefined),
  }));

export const AssistantConfigSchema = z.object({
  provider: z
    .enum(VALID_PROVIDERS, {
      error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
    })
    .default('anthropic'),
  model: z
    .string({ error: 'model must be a string' })
    .default('claude-opus-4-6'),
  imageGenModel: z
    .string({ error: 'imageGenModel must be a string' })
    .default('gemini-2.5-flash-image'),
  apiKeys: z
    .record(z.string(), z.string({ error: 'Each apiKeys value must be a string' }))
    .default({}),
  webSearchProvider: z
    .enum(VALID_WEB_SEARCH_PROVIDERS, {
      error: `webSearchProvider must be one of: ${VALID_WEB_SEARCH_PROVIDERS.join(', ')}`,
    })
    .default('anthropic-native'),
  providerOrder: z
    .array(z.enum(VALID_PROVIDERS, {
      error: `Each providerOrder entry must be one of: ${VALID_PROVIDERS.join(', ')}`,
    }))
    .default([]),
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
    },
    segmentation: {
      targetTokens: 450,
      overlapTokens: 60,
    },
    jobs: {
      workerConcurrency: 2,
      batchSize: 10,
    },
    retention: {
      keepRawForever: true,
    },
    cleanup: {
      enabled: true,
      enqueueIntervalMs: 6 * 60 * 60 * 1000,
      resolvedConflictRetentionMs: 30 * 24 * 60 * 60 * 1000,
      supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
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
    },
    conflicts: {
      enabled: true,
      gateMode: 'soft',
      reaskCooldownTurns: 3,
      resolverLlmTimeoutMs: 12000,
      relevanceThreshold: 0.3,
      askOnIrrelevantTurns: false,
      conflictableKinds: ['preference', 'profile', 'constraint', 'instruction', 'style'],
    },
    profile: {
      enabled: true,
      maxInjectTokens: 800,
    },
  }),
  dataDir: z
    .string({ error: 'dataDir must be a string' })
    .default(getDataDir()),
  timeouts: TimeoutConfigSchema.default({
    shellMaxTimeoutSec: 600,
    shellDefaultTimeoutSec: 120,
    permissionTimeoutSec: 300,
    toolExecutionTimeoutSec: 120,
    providerStreamTimeoutSec: 300,
  }),
  sandbox: SandboxConfigSchema.default({
    enabled: true,
    backend: 'docker',
    docker: {
      image: 'vellum-sandbox:latest',
      shell: 'bash',
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
    action: 'redact',
    entropyThreshold: 4.0,
    allowOneTimeSend: false,
    blockIngress: true,
  }),
  permissions: PermissionsConfigSchema.default({
    mode: 'workspace',
  }),
  auditLog: AuditLogConfigSchema.default({
    retentionDays: 0,
  }),
  logFile: LogFileConfigSchema.default({
    dir: undefined,
    retentionDays: 30,
  }),
  pricingOverrides: z
    .array(ModelPricingOverrideSchema)
    .default([]),
  agentHeartbeat: AgentHeartbeatConfigSchema.default({
    enabled: false,
    intervalMs: 3_600_000,
  }),
  swarm: SwarmConfigSchema.default({
    enabled: true,
    maxWorkers: 3,
    maxTasks: 8,
    maxRetriesPerTask: 1,
    workerTimeoutSec: 900,
    plannerModel: 'claude-haiku-4-5-20251001',
    synthesizerModel: 'claude-sonnet-4-6',
  }),
  skills: SkillsConfigSchema.default({
    entries: {},
    load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
    install: { nodeManager: 'npm' },
    allowBundled: null,
  }),
  workspaceGit: WorkspaceGitConfigSchema.default({
    turnCommitMaxWaitMs: 4000,
    failureBackoffBaseMs: 2000,
    failureBackoffMaxMs: 60000,
    interactiveGitTimeoutMs: 10000,
    enrichmentQueueSize: 50,
    enrichmentConcurrency: 1,
    enrichmentJobTimeoutMs: 30000,
    enrichmentMaxRetries: 2,
    commitMessageLLM: {
      enabled: false,
      useConfiguredProvider: true,
      providerFastModelOverrides: {},
      timeoutMs: 600,
      maxTokens: 120,
      temperature: 0.2,
      maxFilesInPrompt: 30,
      maxDiffBytes: 12000,
      minRemainingTurnBudgetMs: 1000,
      breaker: {
        openAfterFailures: 3,
        backoffBaseMs: 2000,
        backoffMaxMs: 60000,
      },
    },
  }),
  calls: CallsConfigSchema.default({
    enabled: true,
    provider: 'twilio',
    maxDurationSeconds: 3600,
    userConsultTimeoutSeconds: 120,
    disclosure: {
      enabled: true,
      text: 'At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent. Do not say "AI assistant".',
    },
    safety: {
      denyCategories: [],
    },
    voice: {
      mode: 'twilio_standard',
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      fallbackToStandardOnError: true,
      elevenlabs: {
        voiceId: '',
        voiceModelId: '',
        speed: 1.0,
        stability: 0.5,
        similarityBoost: 0.75,
        useSpeakerBoost: true,
        agentId: '',
        apiBaseUrl: 'https://api.elevenlabs.io',
        registerCallTimeoutMs: 5000,
      },
    },
    callerIdentity: {
      allowPerCallOverride: true,
    },
    verification: {
      enabled: false,
      maxAttempts: 3,
      codeLength: 6,
    },
  }),
  sms: SmsConfigSchema.default({
    enabled: false,
    provider: 'twilio',
    phoneNumber: '',
  }),
  ingress: IngressConfigSchema,
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
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type LogFileConfig = z.infer<typeof LogFileConfigSchema>;
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type ContextWindowConfig = z.infer<typeof ContextWindowConfigSchema>;
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
export type ModelPricingOverride = z.infer<typeof ModelPricingOverrideSchema>;
export type SkillEntryConfig = z.infer<typeof SkillEntryConfigSchema>;
export type SkillsLoadConfig = z.infer<typeof SkillsLoadConfigSchema>;
export type SkillsInstallConfig = z.infer<typeof SkillsInstallConfigSchema>;
export type AgentHeartbeatConfig = z.infer<typeof AgentHeartbeatConfigSchema>;
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
export type WorkspaceGitConfig = z.infer<typeof WorkspaceGitConfigSchema>;
export type CallsConfig = z.infer<typeof CallsConfigSchema>;
export type CallsDisclosureConfig = z.infer<typeof CallsDisclosureConfigSchema>;
export type CallsSafetyConfig = z.infer<typeof CallsSafetyConfigSchema>;
export type CallsVoiceConfig = z.infer<typeof CallsVoiceConfigSchema>;
export type CallsElevenLabsConfig = z.infer<typeof CallsElevenLabsConfigSchema>;
export type CallerIdentityConfig = z.infer<typeof CallerIdentityConfigSchema>;
export type CallsVerificationConfig = z.infer<typeof CallsVerificationConfigSchema>;
export type SmsConfig = z.infer<typeof SmsConfigSchema>;
export type IngressConfig = z.infer<typeof IngressConfigSchema>;
