import { z } from "zod";

import { getDataDir } from "../util/platform.js";

// Re-export all domain schemas
export { AnalysisConfigSchema } from "./schemas/analysis.js";
export type { BackupConfig, BackupDestination } from "./schemas/backup.js";
export { BackupConfigSchema } from "./schemas/backup.js";
export { VALID_CALLER_IDENTITY_MODES } from "./schemas/calls.js";
export { DEFAULT_ELEVENLABS_VOICE_ID } from "./schemas/elevenlabs.js";
export type {
  ContextOverflowRecoveryConfig,
  ContextWindowConfig,
  ModelPricingOverride,
  ThinkingConfig,
} from "./schemas/inference.js";
export {
  ContextOverflowRecoveryConfigSchema,
  ContextWindowConfigSchema,
  ModelPricingOverrideSchema,
  ThinkingConfigSchema,
} from "./schemas/inference.js";
export type {
  IngressConfig,
  IngressRateLimitConfig,
  IngressWebhookConfig,
} from "./schemas/ingress.js";
export { IngressConfigSchema } from "./schemas/ingress.js";
export type { JournalConfig } from "./schemas/journal.js";
export { JournalConfigSchema } from "./schemas/journal.js";
export type {
  LLMCallSite,
  LLMCallSiteConfig,
  LLMConfig,
  LLMConfigBase,
  LLMConfigFragment,
} from "./schemas/llm.js";
export { LLMCallSiteEnum, LLMSchema } from "./schemas/llm.js";
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
export { MemoryRetrievalConfigSchema } from "./schemas/memory-retrieval.js";
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
export type { SecretDetectionConfig } from "./schemas/security.js";
export { SecretDetectionConfigSchema } from "./schemas/security.js";
export type {
  ImageGenerationService,
  InferenceService,
  ServiceMode,
  Services,
  WebSearchService,
} from "./schemas/services.js";
export {
  ServicesSchema,
  VALID_INFERENCE_PROVIDERS,
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
  SkillEntryConfigSchema,
  SkillsConfigSchema,
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
import { ConversationsConfigSchema } from "./schemas/conversations.js";
import { FilingConfigSchema } from "./schemas/filing.js";
import { HeartbeatConfigSchema } from "./schemas/heartbeat.js";
import { HostBrowserConfigSchema } from "./schemas/host-browser.js";
import { IngressConfigSchema } from "./schemas/ingress.js";
import { JournalConfigSchema } from "./schemas/journal.js";
import { LLMSchema } from "./schemas/llm.js";
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
import { SecretDetectionConfigSchema } from "./schemas/security.js";
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
    auditLog: AuditLogConfigSchema.default(AuditLogConfigSchema.parse({})),
    logFile: LogFileConfigSchema.default(
      LogFileConfigSchema.parse({ dir: getDataDir() + "/logs" }),
    ),
    // Unified LLM configuration block. The unique source of truth for
    // provider/model/maxTokens/effort/speed/temperature/thinking/contextWindow
    // and pricing overrides for every call site in the assistant.
    //
    // Default values live on each leaf inside `LLMSchema` (see
    // `schemas/llm.ts`), so `LLMSchema.parse({})` returns a fully-populated
    // object. This matches the pattern used by sibling schemas above and
    // ensures the loader's leaf-deletion recovery path can repair a partially
    // invalid `llm` block without falling back to `cloneDefaultConfig()`.
    llm: LLMSchema.default(LLMSchema.parse({})),
    filing: FilingConfigSchema.default(FilingConfigSchema.parse({})),
    heartbeat: HeartbeatConfigSchema.default(HeartbeatConfigSchema.parse({})),
    updates: UpdatesConfigSchema.default(UpdatesConfigSchema.parse({})),
    hostBrowser: HostBrowserConfigSchema.default(
      HostBrowserConfigSchema.parse({}),
    ),
    conversations: ConversationsConfigSchema.default(
      ConversationsConfigSchema.parse({}),
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
    // Per-plugin config blocks keyed by plugin name. The schema is intentionally
    // permissive — each plugin's manifest supplies its own validator which the
    // plugin bootstrap (`external-plugins-bootstrap.ts`) runs against the raw
    // block under `plugins.<name>` before handing the parsed result to the
    // plugin's `init()`. Keeping this open here means adding a new plugin does
    // not require a core-schema change, while invalid configs still surface
    // through the plugin's own validator at bootstrap.
    plugins: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Per-plugin configuration keyed by plugin name. Validated downstream by each plugin's manifest.config validator at bootstrap.",
      ),
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
    const llmContextWindow = config.llm?.default?.contextWindow;
    if (
      llmContextWindow?.targetBudgetRatio != null &&
      llmContextWindow?.compactThreshold != null &&
      llmContextWindow.targetBudgetRatio >= llmContextWindow.compactThreshold
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["llm", "default", "contextWindow", "targetBudgetRatio"],
        message:
          "llm.default.contextWindow.targetBudgetRatio must be less than llm.default.contextWindow.compactThreshold",
      });
    }
    if (
      llmContextWindow?.targetBudgetRatio != null &&
      llmContextWindow?.summaryBudgetRatio != null &&
      llmContextWindow.targetBudgetRatio <= llmContextWindow.summaryBudgetRatio
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["llm", "default", "contextWindow", "targetBudgetRatio"],
        message:
          "llm.default.contextWindow.targetBudgetRatio must be greater than llm.default.contextWindow.summaryBudgetRatio",
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
