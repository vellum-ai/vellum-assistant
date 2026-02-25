import { z } from 'zod';

import { getDataDir } from '../util/platform.js';

// Re-export all domain schemas
export type {
  AgentHeartbeatConfig,
  SwarmConfig,
  WorkspaceGitConfig,
} from './agent-schema.js';
export {
  AgentHeartbeatConfigSchema,
  SwarmConfigSchema,
  WorkspaceGitConfigSchema,
} from './agent-schema.js';
export type {
  CallerIdentityConfig,
  CallsConfig,
  CallsDisclosureConfig,
  CallsElevenLabsConfig,
  CallsSafetyConfig,
  CallsVerificationConfig,
  CallsVoiceConfig,
} from './calls-schema.js';
export {
  CallerIdentityConfigSchema,
  CallsConfigSchema,
  CallsDisclosureConfigSchema,
  CallsElevenLabsConfigSchema,
  CallsSafetyConfigSchema,
  CallsVerificationConfigSchema,
  CallsVoiceConfigSchema,
  VALID_CALLER_IDENTITY_MODES,
} from './calls-schema.js';
export type {
  AuditLogConfig,
  ContextWindowConfig,
  DaemonConfig,
  IngressConfig,
  IngressRateLimitConfig,
  IngressWebhookConfig,
  LogFileConfig,
  ModelPricingOverride,
  PermissionsConfig,
  PlatformConfig,
  RateLimitConfig,
  SecretDetectionConfig,
  SmsConfig,
  ThinkingConfig,
  TimeoutConfig,
} from './core-schema.js';
export {
  AuditLogConfigSchema,
  ContextWindowConfigSchema,
  DaemonConfigSchema,
  IngressConfigSchema,
  IngressRateLimitConfigSchema,
  IngressWebhookConfigSchema,
  LogFileConfigSchema,
  ModelPricingOverrideSchema,
  PermissionsConfigSchema,
  PlatformConfigSchema,
  RateLimitConfigSchema,
  SecretDetectionConfigSchema,
  SmsConfigSchema,
  ThinkingConfigSchema,
  TimeoutConfigSchema,
} from './core-schema.js';
export type {
  MemoryCleanupConfig,
  MemoryConfig,
  MemoryConflictsConfig,
  MemoryEmbeddingsConfig,
  MemoryEntityConfig,
  MemoryExtractionConfig,
  MemoryJobsConfig,
  MemoryProfileConfig,
  MemoryRerankingConfig,
  MemoryRetentionConfig,
  MemoryRetrievalConfig,
  MemorySegmentationConfig,
  MemorySummarizationConfig,
  QdrantConfig,
} from './memory-schema.js';
export {
  MemoryCleanupConfigSchema,
  MemoryConfigSchema,
  MemoryConflictsConfigSchema,
  MemoryDynamicBudgetConfigSchema,
  MemoryEarlyTerminationConfigSchema,
  MemoryEmbeddingsConfigSchema,
  MemoryEntityConfigSchema,
  MemoryExtractionConfigSchema,
  MemoryJobsConfigSchema,
  MemoryProfileConfigSchema,
  MemoryRerankingConfigSchema,
  MemoryRetentionConfigSchema,
  MemoryRetrievalConfigSchema,
  MemorySegmentationConfigSchema,
  MemorySummarizationConfigSchema,
  QdrantConfigSchema,
} from './memory-schema.js';
export type {
  NotificationsConfig,
} from './notifications-schema.js';
export {
  NotificationsConfigSchema,
} from './notifications-schema.js';
export type {
  DockerConfig,
  SandboxConfig,
} from './sandbox-schema.js';
export {
  DockerConfigSchema,
  SandboxConfigSchema,
} from './sandbox-schema.js';
export type {
  SkillEntryConfig,
  SkillsConfig,
  SkillsInstallConfig,
  SkillsLoadConfig,
} from './skills-schema.js';
export {
  SkillEntryConfigSchema,
  SkillsConfigSchema,
  SkillsInstallConfigSchema,
  SkillsLoadConfigSchema,
} from './skills-schema.js';

// Imports for AssistantConfigSchema composition
import { AgentHeartbeatConfigSchema, SwarmConfigSchema, WorkspaceGitConfigSchema } from './agent-schema.js';
import { CallsConfigSchema } from './calls-schema.js';
import {
  AuditLogConfigSchema,
  ContextWindowConfigSchema,
  DaemonConfigSchema,
  IngressConfigSchema,
  LogFileConfigSchema,
  ModelPricingOverrideSchema,
  PermissionsConfigSchema,
  PlatformConfigSchema,
  RateLimitConfigSchema,
  SecretDetectionConfigSchema,
  SmsConfigSchema,
  ThinkingConfigSchema,
  TimeoutConfigSchema,
} from './core-schema.js';
import { MemoryConfigSchema } from './memory-schema.js';
import { NotificationsConfigSchema } from './notifications-schema.js';
import { SandboxConfigSchema } from './sandbox-schema.js';
import { SkillsConfigSchema } from './skills-schema.js';

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
  if (config.contextWindow?.targetInputTokens != null && config.contextWindow?.maxInputTokens != null &&
      config.contextWindow.targetInputTokens >= config.contextWindow.maxInputTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contextWindow', 'targetInputTokens'],
      message: 'contextWindow.targetInputTokens must be less than contextWindow.maxInputTokens',
    });
  }
  const segmentation = config.memory?.segmentation;
  if (segmentation && segmentation.overlapTokens >= segmentation.targetTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memory', 'segmentation', 'overlapTokens'],
      message: 'memory.segmentation.overlapTokens must be less than memory.segmentation.targetTokens',
    });
  }
  const dynamicBudget = config.memory?.retrieval?.dynamicBudget;
  if (dynamicBudget && dynamicBudget.minInjectTokens > dynamicBudget.maxInjectTokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['memory', 'retrieval', 'dynamicBudget'],
      message: 'memory.retrieval.dynamicBudget.minInjectTokens must be <= memory.retrieval.dynamicBudget.maxInjectTokens',
    });
  }
});

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
