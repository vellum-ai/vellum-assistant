import { z } from 'zod';

const VALID_SECRET_ACTIONS = ['redact', 'warn', 'block', 'prompt'] as const;
const VALID_PERMISSIONS_MODES = ['legacy', 'strict', 'workspace'] as const;
const VALID_SMS_PROVIDERS = ['twilio'] as const;

export const TimeoutConfigSchema = z.object({
  shellMaxTimeoutSec: z
    .number({ error: 'timeouts.shellMaxTimeoutSec must be a number' })
    .finite('timeouts.shellMaxTimeoutSec must be finite')
    .positive('timeouts.shellMaxTimeoutSec must be a positive number')
    .default(600),
  shellDefaultTimeoutSec: z
    .number({ error: 'timeouts.shellDefaultTimeoutSec must be a number' })
    .finite('timeouts.shellDefaultTimeoutSec must be finite')
    .positive('timeouts.shellDefaultTimeoutSec must be a positive number')
    .default(120),
  permissionTimeoutSec: z
    .number({ error: 'timeouts.permissionTimeoutSec must be a number' })
    .finite('timeouts.permissionTimeoutSec must be finite')
    .positive('timeouts.permissionTimeoutSec must be a positive number')
    .default(300),
  toolExecutionTimeoutSec: z
    .number({ error: 'timeouts.toolExecutionTimeoutSec must be a number' })
    .finite('timeouts.toolExecutionTimeoutSec must be finite')
    .positive('timeouts.toolExecutionTimeoutSec must be a positive number')
    .default(120),
  providerStreamTimeoutSec: z
    .number({ error: 'timeouts.providerStreamTimeoutSec must be a number' })
    .finite('timeouts.providerStreamTimeoutSec must be finite')
    .positive('timeouts.providerStreamTimeoutSec must be a positive number')
    .default(300),
});

export const RateLimitConfigSchema = z.object({
  maxRequestsPerMinute: z
    .number({ error: 'rateLimit.maxRequestsPerMinute must be a number' })
    .int('rateLimit.maxRequestsPerMinute must be an integer')
    .nonnegative('rateLimit.maxRequestsPerMinute must be a non-negative integer')
    .default(0),
  maxTokensPerSession: z
    .number({ error: 'rateLimit.maxTokensPerSession must be a number' })
    .int('rateLimit.maxTokensPerSession must be an integer')
    .nonnegative('rateLimit.maxTokensPerSession must be a non-negative integer')
    .default(0),
});

export const SecretDetectionConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'secretDetection.enabled must be a boolean' })
    .default(true),
  action: z
    .enum(VALID_SECRET_ACTIONS, {
      error: `secretDetection.action must be one of: ${VALID_SECRET_ACTIONS.join(', ')}`,
    })
    .default('redact'),
  entropyThreshold: z
    .number({ error: 'secretDetection.entropyThreshold must be a number' })
    .finite('secretDetection.entropyThreshold must be finite')
    .positive('secretDetection.entropyThreshold must be a positive number')
    .default(4.0),
  allowOneTimeSend: z
    .boolean({ error: 'secretDetection.allowOneTimeSend must be a boolean' })
    .default(false),
  blockIngress: z
    .boolean({ error: 'secretDetection.blockIngress must be a boolean' })
    .default(true),
});

export const PermissionsConfigSchema = z.object({
  mode: z
    .enum(VALID_PERMISSIONS_MODES, {
      error: `permissions.mode must be one of: ${VALID_PERMISSIONS_MODES.join(', ')}`,
    })
    .default('workspace'),
});

export const AuditLogConfigSchema = z.object({
  retentionDays: z
    .number({ error: 'auditLog.retentionDays must be a number' })
    .int('auditLog.retentionDays must be an integer')
    .nonnegative('auditLog.retentionDays must be a non-negative integer')
    .default(0),
});

export const LogFileConfigSchema = z.object({
  dir: z
    .string({ error: 'logFile.dir must be a string' })
    .optional(),
  retentionDays: z
    .number({ error: 'logFile.retentionDays must be a number' })
    .int('logFile.retentionDays must be an integer')
    .positive('logFile.retentionDays must be a positive integer')
    .default(30),
});

export const ThinkingConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'thinking.enabled must be a boolean' })
    .default(false),
  budgetTokens: z
    .number({ error: 'thinking.budgetTokens must be a number' })
    .int('thinking.budgetTokens must be an integer')
    .positive('thinking.budgetTokens must be a positive integer')
    .default(10000),
  streamThinking: z
    .boolean({ error: 'thinking.streamThinking must be a boolean' })
    .default(false),
});

export const ContextWindowConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'contextWindow.enabled must be a boolean' })
    .default(true),
  maxInputTokens: z
    .number({ error: 'contextWindow.maxInputTokens must be a number' })
    .int('contextWindow.maxInputTokens must be an integer')
    .positive('contextWindow.maxInputTokens must be a positive integer')
    .default(180000),
  targetInputTokens: z
    .number({ error: 'contextWindow.targetInputTokens must be a number' })
    .int('contextWindow.targetInputTokens must be an integer')
    .positive('contextWindow.targetInputTokens must be a positive integer')
    .default(110000),
  compactThreshold: z
    .number({ error: 'contextWindow.compactThreshold must be a number' })
    .finite('contextWindow.compactThreshold must be finite')
    .gt(0, 'contextWindow.compactThreshold must be greater than 0')
    .lte(1, 'contextWindow.compactThreshold must be less than or equal to 1')
    .default(0.8),
  preserveRecentUserTurns: z
    .number({ error: 'contextWindow.preserveRecentUserTurns must be a number' })
    .int('contextWindow.preserveRecentUserTurns must be an integer')
    .positive('contextWindow.preserveRecentUserTurns must be a positive integer')
    .default(8),
  summaryMaxTokens: z
    .number({ error: 'contextWindow.summaryMaxTokens must be a number' })
    .int('contextWindow.summaryMaxTokens must be an integer')
    .positive('contextWindow.summaryMaxTokens must be a positive integer')
    .default(1200),
  chunkTokens: z
    .number({ error: 'contextWindow.chunkTokens must be a number' })
    .int('contextWindow.chunkTokens must be an integer')
    .positive('contextWindow.chunkTokens must be a positive integer')
    .default(12000),
});

export const ModelPricingOverrideSchema = z.object({
  provider: z.string({ error: 'pricingOverrides[].provider must be a string' }),
  modelPattern: z.string({ error: 'pricingOverrides[].modelPattern must be a string' }),
  inputPer1M: z
    .number({ error: 'pricingOverrides[].inputPer1M must be a number' })
    .nonnegative('pricingOverrides[].inputPer1M must be a non-negative number'),
  outputPer1M: z
    .number({ error: 'pricingOverrides[].outputPer1M must be a number' })
    .nonnegative('pricingOverrides[].outputPer1M must be a non-negative number'),
});

export const SmsConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'sms.enabled must be a boolean' })
    .default(false),
  provider: z
    .enum(VALID_SMS_PROVIDERS, {
      error: `sms.provider must be one of: ${VALID_SMS_PROVIDERS.join(', ')}`,
    })
    .default('twilio'),
  phoneNumber: z
    .string({ error: 'sms.phoneNumber must be a string' })
    .default(''),
  assistantPhoneNumbers: z
    .record(z.string(), z.string({ error: 'sms.assistantPhoneNumbers values must be strings' }))
    .optional(),
});

const IngressBaseSchema = z.object({
  enabled: z
    .boolean({ error: 'ingress.enabled must be a boolean' })
    .optional(),
  publicBaseUrl: z
    .string({ error: 'ingress.publicBaseUrl must be a string' })
    .default(''),
});

export const IngressConfigSchema = IngressBaseSchema
  .default({ publicBaseUrl: '' })
  .transform((val) => ({
    ...val,
    // Backward compatibility: if `enabled` was never explicitly set (undefined),
    // infer it from whether a publicBaseUrl is configured. Existing users who
    // have a URL but predate the `enabled` field should not have their webhooks
    // silently disabled on upgrade.
    //
    // When publicBaseUrl is empty and enabled is unset, leave enabled as
    // undefined so getPublicBaseUrl() can still fall through to the
    // INGRESS_PUBLIC_BASE_URL env-var fallback (env-only setups).
    enabled: val.enabled ?? (val.publicBaseUrl ? true : undefined),
  }));

export const AssistantInboxConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'assistantInbox.enabled must be a boolean' })
    .default(false),
  invitesEnabled: z
    .boolean({ error: 'assistantInbox.invitesEnabled must be a boolean' })
    .default(false),
  memberAclEnabled: z
    .boolean({ error: 'assistantInbox.memberAclEnabled must be a boolean' })
    .default(false),
  policyEnabled: z
    .boolean({ error: 'assistantInbox.policyEnabled must be a boolean' })
    .default(false),
});

export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;
export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type LogFileConfig = z.infer<typeof LogFileConfigSchema>;
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
export type ContextWindowConfig = z.infer<typeof ContextWindowConfigSchema>;
export type ModelPricingOverride = z.infer<typeof ModelPricingOverrideSchema>;
export type SmsConfig = z.infer<typeof SmsConfigSchema>;
export type IngressConfig = z.infer<typeof IngressConfigSchema>;
export type AssistantInboxConfig = z.infer<typeof AssistantInboxConfigSchema>;
