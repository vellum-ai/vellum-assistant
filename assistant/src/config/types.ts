export type {
  AssistantConfig,
  AuditLogConfig,
  CallerIdentityConfig,
  CallsConfig,
  CallsDisclosureConfig,
  CallsSafetyConfig,
  CallsVoiceConfig,
  ContextWindowConfig,
  DaemonConfig,
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
  SwarmConfig,
  ThinkingConfig,
  TimeoutConfig,
  UiConfig,
  WorkspaceGitConfig,
} from "./schema.js";

/**
 * Legacy feature flags section (Record<string, boolean>).
 * Uses the key format `skills.<skillId>.enabled`.
 * Missing key defaults to `true` (enabled); explicit `false` only applies when
 * the corresponding canonical key is declared in the defaults registry.
 *
 * @deprecated Prefer `assistantFeatureFlagValues` with canonical key format
 * `feature_flags.<id>.enabled`. This section is kept for backward compatibility
 * and is still consulted by the resolver as a fallback.
 */
export type FeatureFlags = Record<string, boolean>;

/**
 * Assistant feature flag values using the canonical key format
 * `feature_flags.<id>.enabled`. Takes priority over the legacy
 * `featureFlags` section during resolution, for declared keys.
 */
export type AssistantFeatureFlagValues = Record<string, boolean>;
