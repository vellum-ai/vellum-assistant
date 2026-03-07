import { z } from "zod";

import { getDataDir } from "../util/platform.js";

// Re-export all domain schemas
export type {
  HeartbeatConfig,
  SwarmConfig,
  WorkspaceGitConfig,
} from "./agent-schema.js";
export {
  HeartbeatConfigSchema,
  SwarmConfigSchema,
  WorkspaceGitConfigSchema,
} from "./agent-schema.js";
export type {
  CallerIdentityConfig,
  CallsConfig,
  CallsDisclosureConfig,
  CallsSafetyConfig,
  CallsVerificationConfig,
  CallsVoiceConfig,
} from "./calls-schema.js";
export {
  CallerIdentityConfigSchema,
  CallsConfigSchema,
  CallsDisclosureConfigSchema,
  CallsSafetyConfigSchema,
  CallsVerificationConfigSchema,
  CallsVoiceConfigSchema,
  VALID_CALLER_IDENTITY_MODES,
} from "./calls-schema.js";
export type {
  AuditLogConfig,
  AvatarConfig,
  ContextOverflowRecoveryConfig,
  ContextWindowConfig,
  DaemonConfig,
  Effort,
  IngressConfig,
  IngressRateLimitConfig,
  IngressWebhookConfig,
  LogFileConfig,
  ModelPricingOverride,
  PermissionsConfig,
  PlatformConfig,
  RateLimitConfig,
  SecretDetectionConfig,
  ThinkingConfig,
  TimeoutConfig,
  TwilioConfig,
  UiConfig,
  WhatsAppConfig,
} from "./core-schema.js";
export {
  AuditLogConfigSchema,
  AvatarConfigSchema,
  ContextOverflowRecoveryConfigSchema,
  ContextWindowConfigSchema,
  DaemonConfigSchema,
  EffortSchema,
  IngressConfigSchema,
  IngressRateLimitConfigSchema,
  IngressWebhookConfigSchema,
  LogFileConfigSchema,
  ModelPricingOverrideSchema,
  PermissionsConfigSchema,
  PlatformConfigSchema,
  RateLimitConfigSchema,
  SecretDetectionConfigSchema,
  ThinkingConfigSchema,
  TimeoutConfigSchema,
  TwilioConfigSchema,
  UiConfigSchema,
  WhatsAppConfigSchema,
} from "./core-schema.js";
export type { ElevenLabsConfig } from "./elevenlabs-schema.js";
export {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsConfigSchema,
} from "./elevenlabs-schema.js";
export type { McpConfig, McpServerConfig, McpTransport } from "./mcp-schema.js";
export {
  McpConfigSchema,
  McpServerConfigSchema,
  McpTransportSchema,
} from "./mcp-schema.js";
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
} from "./memory-schema.js";
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
} from "./memory-schema.js";
export type { NotificationsConfig } from "./notifications-schema.js";
export { NotificationsConfigSchema } from "./notifications-schema.js";
export type { SandboxConfig } from "./sandbox-schema.js";
export { SandboxConfigSchema } from "./sandbox-schema.js";
export type {
  RemotePolicyConfig,
  RemoteProviderConfig,
  RemoteProvidersConfig,
  SkillEntryConfig,
  SkillsConfig,
  SkillsInstallConfig,
  SkillsLoadConfig,
} from "./skills-schema.js";
export {
  RemotePolicyConfigSchema,
  RemoteProviderConfigSchema,
  RemoteProvidersConfigSchema,
  SkillEntryConfigSchema,
  SkillsConfigSchema,
  SkillsInstallConfigSchema,
  SkillsLoadConfigSchema,
} from "./skills-schema.js";

// Imports for AssistantConfigSchema composition
import {
  HeartbeatConfigSchema,
  SwarmConfigSchema,
  WorkspaceGitConfigSchema,
} from "./agent-schema.js";
import { CallsConfigSchema } from "./calls-schema.js";
import {
  AuditLogConfigSchema,
  AvatarConfigSchema,
  ContextWindowConfigSchema,
  DaemonConfigSchema,
  EffortSchema,
  IngressConfigSchema,
  LogFileConfigSchema,
  ModelPricingOverrideSchema,
  PermissionsConfigSchema,
  PlatformConfigSchema,
  RateLimitConfigSchema,
  SecretDetectionConfigSchema,
  ThinkingConfigSchema,
  TimeoutConfigSchema,
  TwilioConfigSchema,
  UiConfigSchema,
  WhatsAppConfigSchema,
} from "./core-schema.js";
import { ElevenLabsConfigSchema } from "./elevenlabs-schema.js";
import { McpConfigSchema } from "./mcp-schema.js";
import { MemoryConfigSchema } from "./memory-schema.js";
import { NotificationsConfigSchema } from "./notifications-schema.js";
import { SandboxConfigSchema } from "./sandbox-schema.js";
import { SkillsConfigSchema } from "./skills-schema.js";

const VALID_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
] as const;
const VALID_WEB_SEARCH_PROVIDERS = [
  "perplexity",
  "brave",
  "anthropic-native",
] as const;

export const AssistantConfigSchema = z
  .object({
    provider: z
      .enum(VALID_PROVIDERS, {
        error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}`,
      })
      .default("anthropic"),
    model: z
      .string({ error: "model must be a string" })
      .default("claude-opus-4-6"),
    imageGenModel: z
      .string({ error: "imageGenModel must be a string" })
      .default("gemini-2.5-flash-image"),
    apiKeys: z
      .record(
        z.string(),
        z.string({ error: "Each apiKeys value must be a string" }),
      )
      .default({} as Record<string, string>),
    webSearchProvider: z
      .enum(VALID_WEB_SEARCH_PROVIDERS, {
        error: `webSearchProvider must be one of: ${VALID_WEB_SEARCH_PROVIDERS.join(
          ", ",
        )}`,
      })
      .default("anthropic-native"),
    providerOrder: z
      .array(
        z.enum(VALID_PROVIDERS, {
          error: `Each providerOrder entry must be one of: ${VALID_PROVIDERS.join(
            ", ",
          )}`,
        }),
      )
      .default([]),
    maxTokens: z
      .number({ error: "maxTokens must be a number" })
      .int("maxTokens must be an integer")
      .positive("maxTokens must be a positive integer")
      .default(16000),
    maxToolUseTurns: z
      .number({ error: "maxToolUseTurns must be a number" })
      .int("maxToolUseTurns must be an integer")
      .nonnegative("maxToolUseTurns must be a non-negative integer")
      .default(40),
    effort: EffortSchema,
    thinking: ThinkingConfigSchema.default(ThinkingConfigSchema.parse({})),
    contextWindow: ContextWindowConfigSchema.default(
      ContextWindowConfigSchema.parse({}),
    ),
    memory: MemoryConfigSchema.default(MemoryConfigSchema.parse({})),
    dataDir: z
      .string({ error: "dataDir must be a string" })
      .default(getDataDir()),
    timeouts: TimeoutConfigSchema.default(TimeoutConfigSchema.parse({})),
    sandbox: SandboxConfigSchema.default(SandboxConfigSchema.parse({})),
    rateLimit: RateLimitConfigSchema.default(RateLimitConfigSchema.parse({})),
    secretDetection: SecretDetectionConfigSchema.default(
      SecretDetectionConfigSchema.parse({}),
    ),
    permissions: PermissionsConfigSchema.default(
      PermissionsConfigSchema.parse({}),
    ),
    auditLog: AuditLogConfigSchema.default(AuditLogConfigSchema.parse({})),
    logFile: LogFileConfigSchema.default(LogFileConfigSchema.parse({})),
    pricingOverrides: z.array(ModelPricingOverrideSchema).default([]),
    heartbeat: HeartbeatConfigSchema.default(HeartbeatConfigSchema.parse({})),
    swarm: SwarmConfigSchema.default(SwarmConfigSchema.parse({})),
    mcp: McpConfigSchema.default(McpConfigSchema.parse({})),
    skills: SkillsConfigSchema.default(SkillsConfigSchema.parse({})),
    workspaceGit: WorkspaceGitConfigSchema.default(
      WorkspaceGitConfigSchema.parse({}),
    ),
    twilio: TwilioConfigSchema.default(TwilioConfigSchema.parse({})),
    calls: CallsConfigSchema.default(CallsConfigSchema.parse({})),
    elevenlabs: ElevenLabsConfigSchema.default(
      ElevenLabsConfigSchema.parse({}),
    ),
    whatsapp: WhatsAppConfigSchema.default(WhatsAppConfigSchema.parse({})),
    ingress: IngressConfigSchema,
    platform: PlatformConfigSchema.default(PlatformConfigSchema.parse({})),
    daemon: DaemonConfigSchema.default(DaemonConfigSchema.parse({})),
    notifications: NotificationsConfigSchema.default(
      NotificationsConfigSchema.parse({}),
    ),
    avatar: AvatarConfigSchema.default(AvatarConfigSchema.parse({})),
    ui: UiConfigSchema.default(UiConfigSchema.parse({})),
    assistantFeatureFlagValues: z
      .record(
        z.string(),
        z.boolean({
          error: "assistantFeatureFlagValues values must be booleans",
        }),
      )
      .optional(),
  })
  .superRefine((config, ctx) => {
    if (
      config.contextWindow?.targetInputTokens != null &&
      config.contextWindow?.maxInputTokens != null &&
      config.contextWindow.targetInputTokens >=
        config.contextWindow.maxInputTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contextWindow", "targetInputTokens"],
        message:
          "contextWindow.targetInputTokens must be less than contextWindow.maxInputTokens",
      });
    }
    const segmentation = config.memory?.segmentation;
    if (
      segmentation &&
      segmentation.overlapTokens >= segmentation.targetTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memory", "segmentation", "overlapTokens"],
        message:
          "memory.segmentation.overlapTokens must be less than memory.segmentation.targetTokens",
      });
    }
    const dynamicBudget = config.memory?.retrieval?.dynamicBudget;
    if (
      dynamicBudget &&
      dynamicBudget.minInjectTokens > dynamicBudget.maxInjectTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memory", "retrieval", "dynamicBudget"],
        message:
          "memory.retrieval.dynamicBudget.minInjectTokens must be <= memory.retrieval.dynamicBudget.maxInjectTokens",
      });
    }
  });

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
