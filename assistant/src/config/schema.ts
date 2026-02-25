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
  PlatformConfigSchema,
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
  PlatformConfig,
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
  PlatformConfigSchema,
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
    .default({} as any),
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
  thinking: ThinkingConfigSchema.default({} as any),
  contextWindow: ContextWindowConfigSchema.default({} as any),
  memory: MemoryConfigSchema.default({} as any),
  dataDir: z
    .string({ error: 'dataDir must be a string' })
    .default(getDataDir()),
  timeouts: TimeoutConfigSchema.default({} as any),
  sandbox: SandboxConfigSchema.default({} as any),
  rateLimit: RateLimitConfigSchema.default({} as any),
  secretDetection: SecretDetectionConfigSchema.default({} as any),
  permissions: PermissionsConfigSchema.default({} as any),
  auditLog: AuditLogConfigSchema.default({} as any),
  logFile: LogFileConfigSchema.default({} as any),
  pricingOverrides: z
    .array(ModelPricingOverrideSchema)
    .default([]),
  agentHeartbeat: AgentHeartbeatConfigSchema.default({} as any),
  swarm: SwarmConfigSchema.default({} as any),
  skills: SkillsConfigSchema.default({} as any),
  workspaceGit: WorkspaceGitConfigSchema.default({} as any),
  calls: CallsConfigSchema.default({} as any),
  sms: SmsConfigSchema.default({} as any),
  ingress: IngressConfigSchema,
  platform: PlatformConfigSchema.default({} as any),
  daemon: DaemonConfigSchema.default({} as any),
  notifications: NotificationsConfigSchema.default({} as any),
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
