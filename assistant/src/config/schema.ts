import { z } from 'zod';
import { getDataDir } from '../util/platform.js';

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama'] as const;
const VALID_SECRET_ACTIONS = ['redact', 'warn', 'block'] as const;

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
});

export const SandboxConfigSchema = z.object({
  enabled: z
    .boolean({ error: 'sandbox.enabled must be a boolean' })
    .default(false),
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
    .default('warn'),
  entropyThreshold: z
    .number({ error: 'secretDetection.entropyThreshold must be a number' })
    .finite('secretDetection.entropyThreshold must be finite')
    .positive('secretDetection.entropyThreshold must be a positive number')
    .default(4.0),
});

export const AuditLogConfigSchema = z.object({
  retentionDays: z
    .number({ error: 'auditLog.retentionDays must be a number' })
    .int('auditLog.retentionDays must be an integer')
    .nonnegative('auditLog.retentionDays must be a non-negative integer')
    .default(0),
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
});

export const AssistantConfigSchema = z.object({
  provider: z
    .enum(VALID_PROVIDERS, {
      error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
    })
    .default('anthropic'),
  model: z
    .string({ error: 'model must be a string' })
    .default('claude-sonnet-4-5-20250929'),
  apiKeys: z
    .record(z.string(), z.string({ error: 'Each apiKeys value must be a string' }))
    .default({}),
  systemPrompt: z
    .string({ error: 'systemPrompt must be a string' })
    .optional(),
  maxTokens: z
    .number({ error: 'maxTokens must be a number' })
    .int('maxTokens must be an integer')
    .positive('maxTokens must be a positive integer')
    .default(64000),
  thinking: ThinkingConfigSchema.default({
    enabled: false,
    budgetTokens: 10000,
  }),
  dataDir: z
    .string({ error: 'dataDir must be a string' })
    .default(getDataDir()),
  timeouts: TimeoutConfigSchema.default({
    shellMaxTimeoutSec: 600,
    shellDefaultTimeoutSec: 120,
    permissionTimeoutSec: 300,
  }),
  sandbox: SandboxConfigSchema.default({
    enabled: false,
  }),
  rateLimit: RateLimitConfigSchema.default({
    maxRequestsPerMinute: 0,
    maxTokensPerSession: 0,
  }),
  secretDetection: SecretDetectionConfigSchema.default({
    enabled: true,
    action: 'warn',
    entropyThreshold: 4.0,
  }),
  auditLog: AuditLogConfigSchema.default({
    retentionDays: 0,
  }),
});

export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;
export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type SecretDetectionConfig = z.infer<typeof SecretDetectionConfigSchema>;
export type AuditLogConfig = z.infer<typeof AuditLogConfigSchema>;
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;
