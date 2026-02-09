export interface TimeoutConfig {
  /** Maximum shell command timeout in seconds. LLM can request up to this. */
  shellMaxTimeoutSec: number;
  /** Default shell command timeout in seconds when LLM doesn't specify one. */
  shellDefaultTimeoutSec: number;
  /** Permission prompt timeout in seconds. */
  permissionTimeoutSec: number;
}

export interface SandboxConfig {
  /** Whether to run shell commands in a sandbox. Default: false. */
  enabled: boolean;
}

export interface RateLimitConfig {
  /** Maximum API requests per minute. 0 = unlimited. */
  maxRequestsPerMinute: number;
  /** Maximum total tokens (input + output) per session. 0 = unlimited. */
  maxTokensPerSession: number;
}

export interface SecretDetectionConfig {
  /** Whether secret detection is enabled. Default: true. */
  enabled: boolean;
  /** What to do when a secret is detected: redact, warn, or block. Default: 'warn'. */
  action: 'redact' | 'warn' | 'block';
  /** Shannon entropy threshold for entropy-based detection. Default: 4.0. */
  entropyThreshold: number;
}

export interface AuditLogConfig {
  /** Number of days to retain tool invocation records. 0 = retain forever. Default: 0. */
  retentionDays: number;
}

export interface AssistantConfig {
  provider: string;
  model: string;
  apiKeys: Record<string, string>;
  systemPrompt?: string;
  maxTokens: number;
  dataDir: string;
  timeouts: TimeoutConfig;
  sandbox: SandboxConfig;
  rateLimit: RateLimitConfig;
  secretDetection: SecretDetectionConfig;
  auditLog: AuditLogConfig;
}
