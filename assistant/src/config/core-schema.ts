import { z } from "zod";

const VALID_SECRET_ACTIONS = ["redact", "warn", "block", "prompt"] as const;
const VALID_PERMISSIONS_MODES = ["strict", "workspace"] as const;
export const TimeoutConfigSchema = z.object({
  shellMaxTimeoutSec: z
    .number({ error: "timeouts.shellMaxTimeoutSec must be a number" })
    .finite("timeouts.shellMaxTimeoutSec must be finite")
    .positive("timeouts.shellMaxTimeoutSec must be a positive number")
    .default(600),
  shellDefaultTimeoutSec: z
    .number({ error: "timeouts.shellDefaultTimeoutSec must be a number" })
    .finite("timeouts.shellDefaultTimeoutSec must be finite")
    .positive("timeouts.shellDefaultTimeoutSec must be a positive number")
    .default(120),
  permissionTimeoutSec: z
    .number({ error: "timeouts.permissionTimeoutSec must be a number" })
    .finite("timeouts.permissionTimeoutSec must be finite")
    .positive("timeouts.permissionTimeoutSec must be a positive number")
    .default(300),
  toolExecutionTimeoutSec: z
    .number({ error: "timeouts.toolExecutionTimeoutSec must be a number" })
    .finite("timeouts.toolExecutionTimeoutSec must be finite")
    .positive("timeouts.toolExecutionTimeoutSec must be a positive number")
    .default(120),
  providerStreamTimeoutSec: z
    .number({ error: "timeouts.providerStreamTimeoutSec must be a number" })
    .finite("timeouts.providerStreamTimeoutSec must be finite")
    .positive("timeouts.providerStreamTimeoutSec must be a positive number")
    .default(300),
});

export const RateLimitConfigSchema = z.object({
  maxRequestsPerMinute: z
    .number({ error: "rateLimit.maxRequestsPerMinute must be a number" })
    .int("rateLimit.maxRequestsPerMinute must be an integer")
    .nonnegative(
      "rateLimit.maxRequestsPerMinute must be a non-negative integer",
    )
    .default(0),
  maxTokensPerSession: z
    .number({ error: "rateLimit.maxTokensPerSession must be a number" })
    .int("rateLimit.maxTokensPerSession must be an integer")
    .nonnegative("rateLimit.maxTokensPerSession must be a non-negative integer")
    .default(0),
});

export const CustomSecretPatternSchema = z.object({
  label: z.string({
    error: "secretDetection.customPatterns[].label must be a string",
  }),
  pattern: z.string({
    error: "secretDetection.customPatterns[].pattern must be a string",
  }),
});

export const SecretDetectionConfigSchema = z.object({
  enabled: z
    .boolean({ error: "secretDetection.enabled must be a boolean" })
    .default(true),
  action: z
    .enum(VALID_SECRET_ACTIONS, {
      error: `secretDetection.action must be one of: ${VALID_SECRET_ACTIONS.join(
        ", ",
      )}`,
    })
    .default("redact"),
  entropyThreshold: z
    .number({ error: "secretDetection.entropyThreshold must be a number" })
    .finite("secretDetection.entropyThreshold must be finite")
    .positive("secretDetection.entropyThreshold must be a positive number")
    .default(4.0),
  allowOneTimeSend: z
    .boolean({ error: "secretDetection.allowOneTimeSend must be a boolean" })
    .default(false),
  blockIngress: z
    .boolean({ error: "secretDetection.blockIngress must be a boolean" })
    .default(true),
  customPatterns: z.array(CustomSecretPatternSchema).optional(),
});

export const PermissionsConfigSchema = z.object({
  mode: z
    .enum(VALID_PERMISSIONS_MODES, {
      error: `permissions.mode must be one of: ${VALID_PERMISSIONS_MODES.join(
        ", ",
      )}`,
    })
    .default("workspace"),
});

export const AuditLogConfigSchema = z.object({
  retentionDays: z
    .number({ error: "auditLog.retentionDays must be a number" })
    .int("auditLog.retentionDays must be an integer")
    .nonnegative("auditLog.retentionDays must be a non-negative integer")
    .default(0),
});

export const LogFileConfigSchema = z.object({
  dir: z.string({ error: "logFile.dir must be a string" }).optional(),
  retentionDays: z
    .number({ error: "logFile.retentionDays must be a number" })
    .int("logFile.retentionDays must be an integer")
    .positive("logFile.retentionDays must be a positive integer")
    .default(30),
});

export const ThinkingConfigSchema = z.object({
  enabled: z
    .boolean({ error: "thinking.enabled must be a boolean" })
    .default(false),
  streamThinking: z
    .boolean({ error: "thinking.streamThinking must be a boolean" })
    .default(false),
});

export const EffortSchema = z
  .enum(["low", "medium", "high"], {
    error: 'effort must be "low", "medium", or "high"',
  })
  .default("high");

export type Effort = z.infer<typeof EffortSchema>;

const VALID_LATEST_TURN_COMPRESSION_POLICIES = [
  "truncate",
  "summarize",
  "drop",
] as const;

export const ContextOverflowRecoveryConfigSchema = z.object({
  enabled: z
    .boolean({
      error: "contextWindow.overflowRecovery.enabled must be a boolean",
    })
    .default(true),
  safetyMarginRatio: z
    .number({
      error:
        "contextWindow.overflowRecovery.safetyMarginRatio must be a number",
    })
    .finite("contextWindow.overflowRecovery.safetyMarginRatio must be finite")
    .gt(
      0,
      "contextWindow.overflowRecovery.safetyMarginRatio must be greater than 0",
    )
    .lt(
      1,
      "contextWindow.overflowRecovery.safetyMarginRatio must be less than 1",
    )
    .default(0.05),
  maxAttempts: z
    .number({
      error: "contextWindow.overflowRecovery.maxAttempts must be a number",
    })
    .int("contextWindow.overflowRecovery.maxAttempts must be an integer")
    .positive(
      "contextWindow.overflowRecovery.maxAttempts must be a positive integer",
    )
    .default(3),
  interactiveLatestTurnCompression: z
    .enum(VALID_LATEST_TURN_COMPRESSION_POLICIES, {
      error: `contextWindow.overflowRecovery.interactiveLatestTurnCompression must be one of: ${VALID_LATEST_TURN_COMPRESSION_POLICIES.join(
        ", ",
      )}`,
    })
    .default("summarize"),
  nonInteractiveLatestTurnCompression: z
    .enum(VALID_LATEST_TURN_COMPRESSION_POLICIES, {
      error: `contextWindow.overflowRecovery.nonInteractiveLatestTurnCompression must be one of: ${VALID_LATEST_TURN_COMPRESSION_POLICIES.join(
        ", ",
      )}`,
    })
    .default("truncate"),
});

export const ContextWindowConfigSchema = z.object({
  enabled: z
    .boolean({ error: "contextWindow.enabled must be a boolean" })
    .default(true),
  maxInputTokens: z
    .number({ error: "contextWindow.maxInputTokens must be a number" })
    .int("contextWindow.maxInputTokens must be an integer")
    .positive("contextWindow.maxInputTokens must be a positive integer")
    .default(200000),
  targetInputTokens: z
    .number({ error: "contextWindow.targetInputTokens must be a number" })
    .int("contextWindow.targetInputTokens must be an integer")
    .positive("contextWindow.targetInputTokens must be a positive integer")
    .default(110000),
  compactThreshold: z
    .number({ error: "contextWindow.compactThreshold must be a number" })
    .finite("contextWindow.compactThreshold must be finite")
    .gt(0, "contextWindow.compactThreshold must be greater than 0")
    .lte(1, "contextWindow.compactThreshold must be less than or equal to 1")
    .default(0.8),
  preserveRecentUserTurns: z
    .number({ error: "contextWindow.preserveRecentUserTurns must be a number" })
    .int("contextWindow.preserveRecentUserTurns must be an integer")
    .positive(
      "contextWindow.preserveRecentUserTurns must be a positive integer",
    )
    .default(8),
  summaryMaxTokens: z
    .number({ error: "contextWindow.summaryMaxTokens must be a number" })
    .int("contextWindow.summaryMaxTokens must be an integer")
    .positive("contextWindow.summaryMaxTokens must be a positive integer")
    .default(1200),
  chunkTokens: z
    .number({ error: "contextWindow.chunkTokens must be a number" })
    .int("contextWindow.chunkTokens must be an integer")
    .positive("contextWindow.chunkTokens must be a positive integer")
    .default(12000),
  overflowRecovery: ContextOverflowRecoveryConfigSchema.default(
    ContextOverflowRecoveryConfigSchema.parse({}),
  ),
});

export const ModelPricingOverrideSchema = z.object({
  provider: z.string({ error: "pricingOverrides[].provider must be a string" }),
  modelPattern: z.string({
    error: "pricingOverrides[].modelPattern must be a string",
  }),
  inputPer1M: z
    .number({ error: "pricingOverrides[].inputPer1M must be a number" })
    .nonnegative("pricingOverrides[].inputPer1M must be a non-negative number"),
  outputPer1M: z
    .number({ error: "pricingOverrides[].outputPer1M must be a number" })
    .nonnegative(
      "pricingOverrides[].outputPer1M must be a non-negative number",
    ),
});

export const TwilioConfigSchema = z.object({
  accountSid: z
    .string({ error: "twilio.accountSid must be a string" })
    .default(""),
  authToken: z
    .string({ error: "twilio.authToken must be a string" })
    .default(""),
  phoneNumber: z
    .string({ error: "twilio.phoneNumber must be a string" })
    .default(""),
});

export const WhatsAppConfigSchema = z.object({
  phoneNumber: z
    .string({ error: "whatsapp.phoneNumber must be a string" })
    .default(""),
  deliverAuthBypass: z
    .boolean({ error: "whatsapp.deliverAuthBypass must be a boolean" })
    .default(false),
  timeoutMs: z
    .number({ error: "whatsapp.timeoutMs must be a number" })
    .int("whatsapp.timeoutMs must be an integer")
    .positive("whatsapp.timeoutMs must be a positive integer")
    .default(15_000),
  maxRetries: z
    .number({ error: "whatsapp.maxRetries must be a number" })
    .int("whatsapp.maxRetries must be an integer")
    .nonnegative("whatsapp.maxRetries must be a non-negative integer")
    .default(3),
  initialBackoffMs: z
    .number({ error: "whatsapp.initialBackoffMs must be a number" })
    .int("whatsapp.initialBackoffMs must be an integer")
    .positive("whatsapp.initialBackoffMs must be a positive integer")
    .default(1_000),
});

export const TelegramConfigSchema = z.object({
  botUsername: z
    .string({ error: "telegram.botUsername must be a string" })
    .default(""),
  apiBaseUrl: z
    .string({ error: "telegram.apiBaseUrl must be a string" })
    .default("https://api.telegram.org"),
  deliverAuthBypass: z
    .boolean({ error: "telegram.deliverAuthBypass must be a boolean" })
    .default(false),
  timeoutMs: z
    .number({ error: "telegram.timeoutMs must be a number" })
    .int("telegram.timeoutMs must be an integer")
    .positive("telegram.timeoutMs must be a positive integer")
    .default(15_000),
  maxRetries: z
    .number({ error: "telegram.maxRetries must be a number" })
    .int("telegram.maxRetries must be an integer")
    .nonnegative("telegram.maxRetries must be a non-negative integer")
    .default(3),
  initialBackoffMs: z
    .number({ error: "telegram.initialBackoffMs must be a number" })
    .int("telegram.initialBackoffMs must be an integer")
    .positive("telegram.initialBackoffMs must be a positive integer")
    .default(1_000),
});

export const SlackConfigSchema = z.object({
  deliverAuthBypass: z
    .boolean({ error: "slack.deliverAuthBypass must be a boolean" })
    .default(false),
});

export const IngressWebhookConfigSchema = z.object({
  secret: z
    .string({ error: "ingress.webhook.secret must be a string" })
    .default(""),
  timeoutMs: z
    .number({ error: "ingress.webhook.timeoutMs must be a number" })
    .int("ingress.webhook.timeoutMs must be an integer")
    .positive("ingress.webhook.timeoutMs must be a positive integer")
    .default(30_000),
  maxRetries: z
    .number({ error: "ingress.webhook.maxRetries must be a number" })
    .int("ingress.webhook.maxRetries must be an integer")
    .nonnegative("ingress.webhook.maxRetries must be a non-negative integer")
    .default(2),
  initialBackoffMs: z
    .number({ error: "ingress.webhook.initialBackoffMs must be a number" })
    .int("ingress.webhook.initialBackoffMs must be an integer")
    .positive("ingress.webhook.initialBackoffMs must be a positive integer")
    .default(500),
  maxPayloadBytes: z
    .number({ error: "ingress.webhook.maxPayloadBytes must be a number" })
    .int("ingress.webhook.maxPayloadBytes must be an integer")
    .positive("ingress.webhook.maxPayloadBytes must be a positive integer")
    .default(1_048_576),
});

export const IngressRateLimitConfigSchema = z.object({
  maxRequestsPerMinute: z
    .number({
      error: "ingress.rateLimit.maxRequestsPerMinute must be a number",
    })
    .int("ingress.rateLimit.maxRequestsPerMinute must be an integer")
    .nonnegative(
      "ingress.rateLimit.maxRequestsPerMinute must be a non-negative integer",
    )
    .default(0),
  maxRequestsPerHour: z
    .number({ error: "ingress.rateLimit.maxRequestsPerHour must be a number" })
    .int("ingress.rateLimit.maxRequestsPerHour must be an integer")
    .nonnegative(
      "ingress.rateLimit.maxRequestsPerHour must be a non-negative integer",
    )
    .default(0),
});

const IngressBaseSchema = z.object({
  enabled: z.boolean({ error: "ingress.enabled must be a boolean" }).optional(),
  publicBaseUrl: z
    .string({ error: "ingress.publicBaseUrl must be a string" })
    .refine(
      (val) => val === "" || /^https?:\/\//i.test(val),
      "ingress.publicBaseUrl must be an absolute URL starting with http:// or https://",
    )
    .default(""),
  webhook: IngressWebhookConfigSchema.default(
    IngressWebhookConfigSchema.parse({}),
  ),
  rateLimit: IngressRateLimitConfigSchema.default(
    IngressRateLimitConfigSchema.parse({}),
  ),
  shutdownDrainMs: z
    .number({ error: "ingress.shutdownDrainMs must be a number" })
    .int("ingress.shutdownDrainMs must be an integer")
    .nonnegative("ingress.shutdownDrainMs must be a non-negative integer")
    .default(5_000),
});

export const IngressConfigSchema = IngressBaseSchema.default(
  IngressBaseSchema.parse({}),
).transform((val) => ({
  ...val,
  enabled: val.enabled,
}));

export const VALID_AVATAR_STRATEGIES = [
  "managed_required",
  "managed_prefer",
  "local_only",
] as const;

export const AvatarConfigSchema = z.object({
  generationStrategy: z
    .enum(VALID_AVATAR_STRATEGIES, {
      error: `avatar.generationStrategy must be one of: ${VALID_AVATAR_STRATEGIES.join(", ")}`,
    })
    .default("local_only"),
});

export type AvatarConfig = z.infer<typeof AvatarConfigSchema>;

export const PlatformConfigSchema = z.object({
  baseUrl: z
    .string({ error: "platform.baseUrl must be a string" })
    .refine(
      (val) => val === "" || /^https?:\/\//i.test(val),
      "platform.baseUrl must be an absolute URL starting with http:// or https://",
    )
    .default(""),
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;

export const DaemonConfigSchema = z.object({
  startupSocketWaitMs: z
    .number({ error: "daemon.startupSocketWaitMs must be a number" })
    .int("daemon.startupSocketWaitMs must be an integer")
    .positive("daemon.startupSocketWaitMs must be a positive integer")
    .default(5000),
  stopTimeoutMs: z
    .number({ error: "daemon.stopTimeoutMs must be a number" })
    .int("daemon.stopTimeoutMs must be an integer")
    .positive("daemon.stopTimeoutMs must be a positive integer")
    .default(5000),
  sigkillGracePeriodMs: z
    .number({ error: "daemon.sigkillGracePeriodMs must be a number" })
    .int("daemon.sigkillGracePeriodMs must be an integer")
    .positive("daemon.sigkillGracePeriodMs must be a positive integer")
    .default(2000),
  titleGenerationMaxTokens: z
    .number({ error: "daemon.titleGenerationMaxTokens must be a number" })
    .int("daemon.titleGenerationMaxTokens must be an integer")
    .positive("daemon.titleGenerationMaxTokens must be a positive integer")
    .default(30),
  standaloneRecording: z
    .boolean({ error: "daemon.standaloneRecording must be a boolean" })
    .default(true),
});

export const UiConfigSchema = z.object({
  userTimezone: z
    .string({ error: "ui.userTimezone must be a string" })
    .optional(),
});

export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type CustomSecretPattern = z.infer<typeof CustomSecretPatternSchema>;
export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type LogFileConfig = z.infer<typeof LogFileConfigSchema>;
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type ContextOverflowRecoveryConfig = z.infer<
  typeof ContextOverflowRecoveryConfigSchema
>;
export type ContextWindowConfig = z.infer<typeof ContextWindowConfigSchema>;
export type ModelPricingOverride = z.infer<typeof ModelPricingOverrideSchema>;
export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;
export type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type IngressWebhookConfig = z.infer<typeof IngressWebhookConfigSchema>;
export type IngressRateLimitConfig = z.infer<
  typeof IngressRateLimitConfigSchema
>;
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type IngressConfig = z.infer<typeof IngressConfigSchema>;
export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type UiConfig = z.infer<typeof UiConfigSchema>;
