import { z } from 'zod';
import { getDataDir } from '../util/platform.js';

// Re-export all domain schemas
export {
  MemoryEmbeddingsConfigSchema,
  QdrantConfigSchema,
  MemoryRerankingConfigSchema,
  MemoryDynamicBudgetConfigSchema,
  MemoryEarlyTerminationConfigSchema,
  MemoryRetrievalConfigSchema,
  MemorySegmentationConfigSchema,
  MemoryJobsConfigSchema,
  MemoryRetentionConfigSchema,
  MemoryCleanupConfigSchema,
  MemoryExtractionConfigSchema,
  MemoryEntityConfigSchema,
  MemoryConflictsConfigSchema,
  MemoryProfileConfigSchema,
  MemorySummarizationConfigSchema,
  MemoryConfigSchema,
} from './memory-schema.js';
export type {
  MemoryEmbeddingsConfig,
  MemoryRerankingConfig,
  MemoryRetrievalConfig,
  MemorySegmentationConfig,
  MemoryJobsConfig,
  MemoryRetentionConfig,
  MemoryCleanupConfig,
  MemoryExtractionConfig,
  MemorySummarizationConfig,
  MemoryEntityConfig,
  MemoryConflictsConfig,
  MemoryProfileConfig,
  MemoryConfig,
  QdrantConfig,
} from './memory-schema.js';

export {
  CallsDisclosureConfigSchema,
  CallsSafetyConfigSchema,
  CallsElevenLabsConfigSchema,
  CallsVoiceConfigSchema,
  CallerIdentityConfigSchema,
  CallsVerificationConfigSchema,
  CallsConfigSchema,
  VALID_CALLER_IDENTITY_MODES,
} from './calls-schema.js';
export type {
  CallsConfig,
  CallsDisclosureConfig,
  CallsSafetyConfig,
  CallsVoiceConfig,
  CallsElevenLabsConfig,
  CallerIdentityConfig,
  CallsVerificationConfig,
} from './calls-schema.js';

export {
  DockerConfigSchema,
  SandboxConfigSchema,
} from './sandbox-schema.js';
export type {
  SandboxConfig,
  DockerConfig,
} from './sandbox-schema.js';

export {
  SkillEntryConfigSchema,
  SkillsLoadConfigSchema,
  SkillsInstallConfigSchema,
  SkillsConfigSchema,
} from './skills-schema.js';
export type {
  SkillEntryConfig,
  SkillsLoadConfig,
  SkillsInstallConfig,
  SkillsConfig,
} from './skills-schema.js';

export {
  AgentHeartbeatConfigSchema,
  SwarmConfigSchema,
  WorkspaceGitConfigSchema,
} from './agent-schema.js';
export type {
  AgentHeartbeatConfig,
  SwarmConfig,
  WorkspaceGitConfig,
} from './agent-schema.js';

export {
  NotificationsConfigSchema,
} from './notifications-schema.js';
export type {
  NotificationsConfig,
} from './notifications-schema.js';

export {
  TimeoutConfigSchema,
  RateLimitConfigSchema,
  SecretDetectionConfigSchema,
  PermissionsConfigSchema,
  AuditLogConfigSchema,
  LogFileConfigSchema,
  ThinkingConfigSchema,
  ContextWindowConfigSchema,
  ModelPricingOverrideSchema,
  SmsConfigSchema,
  IngressWebhookConfigSchema,
  IngressRateLimitConfigSchema,
  IngressConfigSchema,
  DaemonConfigSchema,
} from './core-schema.js';
export type {
  TimeoutConfig,
  RateLimitConfig,
  SecretDetectionConfig,
  PermissionsConfig,
  AuditLogConfig,
  LogFileConfig,
  ThinkingConfig,
  ContextWindowConfig,
  ModelPricingOverride,
  SmsConfig,
  IngressWebhookConfig,
  IngressRateLimitConfig,
  IngressConfig,
  DaemonConfig,
} from './core-schema.js';

// Imports for AssistantConfigSchema composition
import { MemoryConfigSchema } from './memory-schema.js';
import { CallsConfigSchema } from './calls-schema.js';
import { SandboxConfigSchema } from './sandbox-schema.js';
import { SkillsConfigSchema } from './skills-schema.js';
import { AgentHeartbeatConfigSchema, SwarmConfigSchema, WorkspaceGitConfigSchema } from './agent-schema.js';
import { NotificationsConfigSchema } from './notifications-schema.js';
import {
  TimeoutConfigSchema,
  RateLimitConfigSchema,
  SecretDetectionConfigSchema,
  PermissionsConfigSchema,
  AuditLogConfigSchema,
  LogFileConfigSchema,
  ThinkingConfigSchema,
  ContextWindowConfigSchema,
  ModelPricingOverrideSchema,
  SmsConfigSchema,
  IngressConfigSchema,
  DaemonConfigSchema,
} from './core-schema.js';

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'fireworks', 'openrouter'] as const;
const VALID_WEB_SEARCH_PROVIDERS = ['perplexity', 'brave', 'anthropic-native'] as const;

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
    .default(16000),
  maxToolUseTurns: z
    .number({ error: 'maxToolUseTurns must be a number' })
    .int('maxToolUseTurns must be an integer')
    .positive('maxToolUseTurns must be a positive integer')
    .default(60),
  thinking: ThinkingConfigSchema.default({
    enabled: false,
    budgetTokens: 10000,
    streamThinking: false,
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
        enabled: false,
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
      conversationRetentionDays: 90,
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
    roleTimeoutsSec: {},
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
  daemon: DaemonConfigSchema.default({
    startupSocketWaitMs: 5000,
    stopTimeoutMs: 5000,
    sigkillGracePeriodMs: 2000,
    titleGenerationMaxTokens: 30,
  }),
  notifications: NotificationsConfigSchema.default({
    enabled: false,
    shadowMode: true,
    decisionModel: 'claude-haiku-4-5-20251001',
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
