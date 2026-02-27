export type {
  AssistantConfig,
  AuditLogConfig,
  CallerIdentityConfig,
  CallsConfig,
  CallsDisclosureConfig,
  CallsElevenLabsConfig,
  CallsSafetyConfig,
  CallsVoiceConfig,
  ContextWindowConfig,
  DaemonConfig,
  DockerConfig,
  HeartbeatConfig,
  IngressConfig,
  LogFileConfig,
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
  ModelPricingOverride,
  NotificationsConfig,
  PermissionsConfig,
  QdrantConfig,
  RateLimitConfig,
  SandboxConfig,
  SecretDetectionConfig,
  SkillEntryConfig,
  SkillsConfig,
  SkillsInstallConfig,
  SkillsLoadConfig,
  SmsConfig,
  SwarmConfig,
  ThinkingConfig,
  TimeoutConfig,
  UiConfig,
  WorkspaceGitConfig,
} from './schema.js';

/**
 * Feature flags are a top-level config section (Record<string, boolean>).
 * Skill feature flags use the key format `skills.<skillId>.enabled`.
 * Missing key defaults to `true` (enabled); explicit `false` disables everywhere.
 */
export type FeatureFlags = Record<string, boolean>;

