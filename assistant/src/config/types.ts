export interface TimeoutConfig {
  /** Maximum shell command timeout in seconds. LLM can request up to this. */
  shellMaxTimeoutSec: number;
  /** Default shell command timeout in seconds when LLM doesn't specify one. */
  shellDefaultTimeoutSec: number;
  /** Permission prompt timeout in seconds. */
  permissionTimeoutSec: number;
}

export interface AssistantConfig {
  provider: string;
  model: string;
  apiKeys: Record<string, string>;
  systemPrompt?: string;
  maxTokens: number;
  dataDir: string;
  timeouts: TimeoutConfig;
}
