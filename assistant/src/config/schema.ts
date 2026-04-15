import { z } from "zod";

import { getDataDir } from "../util/platform.js";

// Re-export all domain schemas
export type { PermissionMode } from "../permissions/permission-mode.js";
export {
  DEFAULT_PERMISSION_MODE,
  PermissionModeSchema,
} from "../permissions/permission-mode.js";
export type { AcpAgentConfig, AcpConfig } from "./acp-schema.js";
export { AcpAgentConfigSchema, AcpConfigSchema } from "./acp-schema.js";
export type { AnalysisConfig } from "./schemas/analysis.js";
export { AnalysisConfigSchema } from "./schemas/analysis.js";
export type { BackupConfig, BackupDestination } from "./schemas/backup.js";
export { BackupConfigSchema } from "./schemas/backup.js";
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
export {
  DEFAULT_ELEVENLABS_VOICE_ID,
  VALID_CONVERSATION_TIMEOUTS,
} from "./schemas/elevenlabs.js";
export type { HeartbeatConfig } from "./schemas/heartbeat.js";
export { HeartbeatConfigSchema } from "./schemas/heartbeat.js";
export type {
  DesktopAutoCdpInspectConfig,
  HostBrowserCdpInspectConfig,
  HostBrowserConfig,
} from "./schemas/host-browser.js";
export {
  DesktopAutoCdpInspectConfigSchema,
  HostBrowserCdpInspectConfigSchema,
  HostBrowserConfigSchema,
} from "./schemas/host-browser.js";
export type {
  ContextOverflowRecoveryConfig,
  ContextWindowConfig,
  Effort,
  ModelPricingOverride,
  Speed,
  ThinkingConfig,
} from "./schemas/inference.js";
export {
  ContextOverflowRecoveryConfigSchema,
  ContextWindowConfigSchema,
  EffortSchema,
  ModelPricingOverrideSchema,
  SpeedSchema,
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
export type { JournalConfig } from "./schemas/journal.js";
export { JournalConfigSchema } from "./schemas/journal.js";
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
export type { MeetService } from "./schemas/meet.js";
export {
  DEFAULT_MEET_OBJECTION_KEYWORDS,
  MeetServiceSchema,
} from "./schemas/meet.js";
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
  MemoryInjectionConfigSchema,
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
export type {
  PermissionsConfig,
  SecretDetectionConfig,
} from "./schemas/security.js";
export {
  PermissionsConfigSchema,
  SecretDetectionConfigSchema,
  VALID_PERMISSIONS_MODES,
} from "./schemas/security.js";
export type {
  ImageGenerationService,
  InferenceService,
  ServiceMode,
  Services,
  WebSearchService,
} from "./schemas/services.js";
// Re-exported under services.* to document that `services.meet` is the
// canonical config path even though the schema itself lives in `meet.ts`.
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
export type { SttProviders, SttService } from "./schemas/stt.js";
export {
  SttProvidersSchema,
  SttServiceSchema,
  VALID_STT_PROVIDERS,
} from "./schemas/stt.js";
export type { RateLimitConfig, TimeoutConfig } from "./schemas/timeouts.js";
export {
  RateLimitConfigSchema,
  TimeoutConfigSchema,
} from "./schemas/timeouts.js";
export type {
  TtsDeepgramProviderConfig,
  TtsElevenLabsProviderConfig,
  TtsFishAudioProviderConfig,
  TtsProviders,
  TtsService,
} from "./schemas/tts.js";
export {
  TtsDeepgramProviderConfigSchema,
  TtsElevenLabsProviderConfigSchema,
  TtsFishAudioProviderConfigSchema,
  TtsProvidersSchema,
  TtsServiceSchema,
  VALID_TTS_PROVIDERS as VALID_TTS_SERVICE_PROVIDERS,
} from "./schemas/tts.js";
export type { UpdatesConfig } from "./schemas/updates.js";
export { UpdatesConfigSchema } from "./schemas/updates.js";
export type { WorkspaceGitConfig } from "./schemas/workspace-git.js";
export { WorkspaceGitConfigSchema } from "./schemas/workspace-git.js";

// Imports for AssistantConfigSchema composition
import { AcpConfigSchema } from "./acp-schema.js";
import { AnalysisConfigSchema } from "./schemas/analysis.js";
import { BackupConfigSchema } from "./schemas/backup.js";
import { CallsConfigSchema } from "./schemas/calls.js";
import {
  SlackConfigSchema,
  TelegramConfigSchema,
  TwilioConfigSchema,
  WhatsAppConfigSchema,
} from "./schemas/channels.js";
import { FilingConfigSchema } from "./schemas/filing.js";
import { HeartbeatConfigSchema } from "./schemas/heartbeat.js";
import { HostBrowserConfigSchema } from "./schemas/host-browser.js";
import {
  ContextWindowConfigSchema,
  EffortSchema,
  ModelPricingOverrideSchema,
  SpeedSchema,
  ThinkingConfigSchema,
} from "./schemas/inference.js";
import { IngressConfigSchema } from "./schemas/ingress.js";
import { JournalConfigSchema } from "./schemas/journal.js";
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
import {
  PermissionsConfigSchema,
  SecretDetectionConfigSchema,
} from "./schemas/security.js";
import { ServicesSchema } from "./schemas/services.js";
import { SkillsConfigSchema } from "./schemas/skills.js";
import {
  RateLimitConfigSchema,
  TimeoutConfigSchema,
} from "./schemas/timeouts.js";
import { UpdatesConfigSchema } from "./schemas/updates.js";
import { WorkspaceGitConfigSchema } from "./schemas/workspace-git.js";

export const AssistantConfigSchema = z
  .object({
    services: ServicesSchema.default(ServicesSchema.parse({})),
    maxTokens: z
      .number({ error: "maxTokens must be a number" })
      .int("maxTokens must be an integer")
      .positive("maxTokens must be a positive integer")
      .default(64000)
      .describe("Maximum number of output tokens per LLM response"),
    effort: EffortSchema,
    speed: SpeedSchema,
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
    filing: FilingConfigSchema.default(FilingConfigSchema.parse({})),
    heartbeat: HeartbeatConfigSchema.default(HeartbeatConfigSchema.parse({})),
    updates: UpdatesConfigSchema.default(UpdatesConfigSchema.parse({})),
    hostBrowser: HostBrowserConfigSchema.default(
      HostBrowserConfigSchema.parse({}),
    ),
    journal: JournalConfigSchema.default(JournalConfigSchema.parse({})),
    analysis: AnalysisConfigSchema.default(AnalysisConfigSchema.parse({})),
    backup: BackupConfigSchema.default(BackupConfigSchema.parse({})),
    mcp: McpConfigSchema.default(McpConfigSchema.parse({})),
    acp: AcpConfigSchema.default(AcpConfigSchema.parse({})),
    skills: SkillsConfigSchema.default(SkillsConfigSchema.parse({})),
    workspaceGit: WorkspaceGitConfigSchema.default(
      WorkspaceGitConfigSchema.parse({}),
    ),
    twilio: TwilioConfigSchema.default(TwilioConfigSchema.parse({})),
    calls: CallsConfigSchema.default(CallsConfigSchema.parse({})),
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
    systemPromptPrefix: z
      .string({ error: "systemPromptPrefix must be a string" })
      .nullable()
      .default(null)
      .describe(
        "Custom text injected at the very beginning of the system prompt. Defaults to null (no injection).",
      ),
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
    const injection = config.memory?.retrieval?.injection;
    const ctxLoad = injection?.contextLoad;
    if (
      ctxLoad &&
      ctxLoad.capabilityReserve + ctxLoad.serendipitySlots >= ctxLoad.maxNodes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memory", "retrieval", "injection", "contextLoad"],
        message:
          "memory.retrieval.injection.contextLoad.capabilityReserve + serendipitySlots must be less than maxNodes",
      });
    }
    const perTurn = injection?.perTurn;
    if (
      perTurn &&
      perTurn.capabilityReserve + perTurn.serendipitySlots >= perTurn.maxNodes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memory", "retrieval", "injection", "perTurn"],
        message:
          "memory.retrieval.injection.perTurn.capabilityReserve + serendipitySlots must be less than maxNodes",
      });
    }
  });

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
