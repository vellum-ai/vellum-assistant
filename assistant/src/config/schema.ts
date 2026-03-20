import { z } from "zod";

import { getDataDir } from "../util/platform.js";

// Re-export all domain schemas
export type { AcpAgentConfig, AcpConfig } from "./acp-schema.js";
export { AcpAgentConfigSchema, AcpConfigSchema } from "./acp-schema.js";
export type {
  CallerIdentityConfig,
  CallsConfig,
  CallsDisclosureConfig,
  CallsSafetyConfig,
  CallsVerificationConfig,
  CallsVoiceConfig,
} from "./schemas/calls.js";
export {
  CallerIdentityConfigSchema,
  CallsConfigSchema,
  CallsDisclosureConfigSchema,
  CallsSafetyConfigSchema,
  CallsVerificationConfigSchema,
  CallsVoiceConfigSchema,
  VALID_CALLER_IDENTITY_MODES,
} from "./schemas/calls.js";
export type {
  SlackConfig,
  TelegramConfig,
  TwilioConfig,
  WhatsAppConfig,
} from "./schemas/channels.js";
export {
  SlackConfigSchema,
  TelegramConfigSchema,
  TwilioConfigSchema,
  WhatsAppConfigSchema,
} from "./schemas/channels.js";
export type { ElevenLabsConfig } from "./schemas/elevenlabs.js";
export {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsConfigSchema,
  VALID_CONVERSATION_TIMEOUTS,
} from "./schemas/elevenlabs.js";
export type { HeartbeatConfig } from "./schemas/heartbeat.js";
export { HeartbeatConfigSchema } from "./schemas/heartbeat.js";
export type {
  ContextOverflowRecoveryConfig,
  ContextWindowConfig,
  Effort,
  ModelPricingOverride,
  ThinkingConfig,
} from "./schemas/inference.js";
export {
  ContextOverflowRecoveryConfigSchema,
  ContextWindowConfigSchema,
  EffortSchema,
  ModelPricingOverrideSchema,
  ThinkingConfigSchema,
} from "./schemas/inference.js";
export type {
  IngressConfig,
  IngressRateLimitConfig,
  IngressWebhookConfig,
} from "./schemas/ingress.js";
export {
  IngressConfigSchema,
  IngressRateLimitConfigSchema,
  IngressWebhookConfigSchema,
} from "./schemas/ingress.js";
export type { AuditLogConfig, LogFileConfig } from "./schemas/logging.js";
export {
  AuditLogConfigSchema,
  LogFileConfigSchema,
} from "./schemas/logging.js";
export type {
  McpConfig,
  McpServerConfig,
  McpTransport,
} from "./schemas/mcp.js";
export {
  McpConfigSchema,
  McpServerConfigSchema,
  McpTransportSchema,
} from "./schemas/mcp.js";
export type { MemoryConfig } from "./schemas/memory.js";
export { MemoryConfigSchema } from "./schemas/memory.js";
export type {
  MemoryCleanupConfig,
  MemoryJobsConfig,
  MemoryRetentionConfig,
} from "./schemas/memory-lifecycle.js";
export {
  MemoryCleanupConfigSchema,
  MemoryJobsConfigSchema,
  MemoryRetentionConfigSchema,
} from "./schemas/memory-lifecycle.js";
export type {
  MemoryExtractionConfig,
  MemorySummarizationConfig,
} from "./schemas/memory-processing.js";
export {
  MemoryExtractionConfigSchema,
  MemorySummarizationConfigSchema,
} from "./schemas/memory-processing.js";
export type { MemoryRetrievalConfig } from "./schemas/memory-retrieval.js";
export {
  MemoryDynamicBudgetConfigSchema,
  MemoryRetrievalConfigSchema,
} from "./schemas/memory-retrieval.js";
export type {
  MemoryEmbeddingsConfig,
  MemorySegmentationConfig,
  QdrantConfig,
} from "./schemas/memory-storage.js";
export {
  MemoryEmbeddingsConfigSchema,
  MemorySegmentationConfigSchema,
  QdrantConfigSchema,
} from "./schemas/memory-storage.js";
export type { NotificationsConfig } from "./schemas/notifications.js";
export { NotificationsConfigSchema } from "./schemas/notifications.js";
export type {
  DaemonConfig,
  PlatformConfig,
  UiConfig,
} from "./schemas/platform.js";
export {
  DaemonConfigSchema,
  PlatformConfigSchema,
  UiConfigSchema,
} from "./schemas/platform.js";
export type { SandboxConfig } from "./schemas/sandbox.js";
export { SandboxConfigSchema } from "./schemas/sandbox.js";
export type {
  PermissionsConfig,
  SecretDetectionConfig,
} from "./schemas/security.js";
export {
  PermissionsConfigSchema,
  SecretDetectionConfigSchema,
} from "./schemas/security.js";
export type {
  ImageGenerationService,
  InferenceService,
  ServiceMode,
  Services,
  WebSearchService,
} from "./schemas/services.js";
export {
  ImageGenerationServiceSchema,
  InferenceServiceSchema,
  ServiceModeSchema,
  ServicesSchema,
  VALID_IMAGE_GEN_PROVIDERS,
  VALID_INFERENCE_PROVIDERS,
  VALID_WEB_SEARCH_PROVIDERS,
  WebSearchServiceSchema,
} from "./schemas/services.js";
export type {
  RemotePolicyConfig,
  RemoteProviderConfig,
  RemoteProvidersConfig,
  SkillEntryConfig,
  SkillsConfig,
  SkillsInstallConfig,
  SkillsLoadConfig,
} from "./schemas/skills.js";
export {
  RemotePolicyConfigSchema,
  RemoteProviderConfigSchema,
  RemoteProvidersConfigSchema,
  SkillEntryConfigSchema,
  SkillsConfigSchema,
  SkillsInstallConfigSchema,
  SkillsLoadConfigSchema,
} from "./schemas/skills.js";
export type { SwarmConfig } from "./schemas/swarm.js";
export { SwarmConfigSchema } from "./schemas/swarm.js";
export type { RateLimitConfig, TimeoutConfig } from "./schemas/timeouts.js";
export {
  RateLimitConfigSchema,
  TimeoutConfigSchema,
} from "./schemas/timeouts.js";
export type { WorkspaceGitConfig } from "./schemas/workspace-git.js";
export { WorkspaceGitConfigSchema } from "./schemas/workspace-git.js";

// Imports for AssistantConfigSchema composition
import { AcpConfigSchema } from "./acp-schema.js";
import { CallsConfigSchema } from "./schemas/calls.js";
import {
  SlackConfigSchema,
  TelegramConfigSchema,
  TwilioConfigSchema,
  WhatsAppConfigSchema,
} from "./schemas/channels.js";
import { ElevenLabsConfigSchema } from "./schemas/elevenlabs.js";
import { HeartbeatConfigSchema } from "./schemas/heartbeat.js";
import {
  ContextWindowConfigSchema,
  EffortSchema,
  ModelPricingOverrideSchema,
  ThinkingConfigSchema,
} from "./schemas/inference.js";
import { IngressConfigSchema } from "./schemas/ingress.js";
import {
  AuditLogConfigSchema,
  LogFileConfigSchema,
} from "./schemas/logging.js";
import { McpConfigSchema } from "./schemas/mcp.js";
import { MemoryConfigSchema } from "./schemas/memory.js";
import { NotificationsConfigSchema } from "./schemas/notifications.js";
import {
  DaemonConfigSchema,
  PlatformConfigSchema,
  UiConfigSchema,
} from "./schemas/platform.js";
import { SandboxConfigSchema } from "./schemas/sandbox.js";
import {
  PermissionsConfigSchema,
  SecretDetectionConfigSchema,
} from "./schemas/security.js";
import {
  ServicesSchema,
  VALID_INFERENCE_PROVIDERS,
} from "./schemas/services.js";
import { SkillsConfigSchema } from "./schemas/skills.js";
import { SwarmConfigSchema } from "./schemas/swarm.js";
import {
  RateLimitConfigSchema,
  TimeoutConfigSchema,
} from "./schemas/timeouts.js";
import { WorkspaceGitConfigSchema } from "./schemas/workspace-git.js";

export const AssistantConfigSchema = z
  .object({
    services: ServicesSchema.default(ServicesSchema.parse({})),
    providerOrder: z
      .array(
        z.enum(VALID_INFERENCE_PROVIDERS, {
          error: `Each providerOrder entry must be one of: ${VALID_INFERENCE_PROVIDERS.join(
            ", ",
          )}`,
        }),
      )
      .default([])
      .describe(
        "Fallback order of LLM providers — the assistant tries each in sequence if the previous one fails",
      ),
    maxTokens: z
      .number({ error: "maxTokens must be a number" })
      .int("maxTokens must be an integer")
      .positive("maxTokens must be a positive integer")
      .default(16000)
      .describe("Maximum number of output tokens per LLM response"),
    effort: EffortSchema,
    thinking: ThinkingConfigSchema.default(ThinkingConfigSchema.parse({})),
    contextWindow: ContextWindowConfigSchema.default(
      ContextWindowConfigSchema.parse({}),
    ),
    memory: MemoryConfigSchema.default(MemoryConfigSchema.parse({})),
    dataDir: z
      .string({ error: "dataDir must be a string" })
      .default(getDataDir())
      .describe("Directory for storing assistant data (database, logs, etc.)"),
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
    logFile: LogFileConfigSchema.default(
      LogFileConfigSchema.parse({ dir: getDataDir() + "/logs" }),
    ),
    pricingOverrides: z
      .array(ModelPricingOverrideSchema)
      .default([])
      .describe(
        "Custom pricing overrides for specific provider/model combinations",
      ),
    heartbeat: HeartbeatConfigSchema.default(HeartbeatConfigSchema.parse({})),
    swarm: SwarmConfigSchema.default(SwarmConfigSchema.parse({})),
    mcp: McpConfigSchema.default(McpConfigSchema.parse({})),
    acp: AcpConfigSchema.default(AcpConfigSchema.parse({})),
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
    telegram: TelegramConfigSchema.default(TelegramConfigSchema.parse({})),
    slack: SlackConfigSchema.default(SlackConfigSchema.parse({})),
    ingress: IngressConfigSchema,
    platform: PlatformConfigSchema.default(PlatformConfigSchema.parse({})),
    daemon: DaemonConfigSchema.default(DaemonConfigSchema.parse({})),
    notifications: NotificationsConfigSchema.default(
      NotificationsConfigSchema.parse({}),
    ),
    ui: UiConfigSchema.default(UiConfigSchema.parse({})),
    assistantFeatureFlagValues: z
      .record(
        z.string(),
        z.boolean({
          error: "assistantFeatureFlagValues values must be booleans",
        }),
      )
      .optional()
      .describe("Feature flag overrides — map of flag names to boolean values"),
    collectUsageData: z
      .boolean()
      .default(true)
      .describe(
        "Whether to collect anonymous usage data to help improve the assistant",
      ),
    sendDiagnostics: z
      .boolean()
      .default(true)
      .describe("Whether to send diagnostic/crash reports"),
    maxStepsPerSession: z
      .number({ error: "maxStepsPerSession must be a number" })
      .int("maxStepsPerSession must be an integer")
      .min(1, "maxStepsPerSession must be >= 1")
      .max(200, "maxStepsPerSession must be <= 200")
      .default(50)
      .describe("Maximum number of computer-use steps per session"),
  })
  .superRefine((config, ctx) => {
    if (
      config.contextWindow?.targetBudgetRatio != null &&
      config.contextWindow?.compactThreshold != null &&
      config.contextWindow.targetBudgetRatio >=
        config.contextWindow.compactThreshold
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contextWindow", "targetBudgetRatio"],
        message:
          "contextWindow.targetBudgetRatio must be less than contextWindow.compactThreshold",
      });
    }
    if (
      config.contextWindow?.targetBudgetRatio != null &&
      config.contextWindow?.summaryBudgetRatio != null &&
      config.contextWindow.targetBudgetRatio <=
        config.contextWindow.summaryBudgetRatio
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contextWindow", "targetBudgetRatio"],
        message:
          "contextWindow.targetBudgetRatio must be greater than contextWindow.summaryBudgetRatio",
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
