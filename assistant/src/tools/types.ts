import type { RiskLevel } from '../permissions/types.js';
import type { ToolDefinition } from '../providers/types.js';

export interface SecretDetectionEvent {
  toolName: string;
  matches: Array<{ type: string; redactedValue: string }>;
  action: 'redact' | 'warn' | 'block';
}

export interface ToolContext {
  workingDir: string;
  sessionId: string;
  conversationId: string;
  /** Optional callback for streaming incremental output to the client. */
  onOutput?: (chunk: string) => void;
  /** Per-session sandbox override. When set, takes precedence over the global config. */
  sandboxOverride?: boolean;
  /** Optional callback when secrets are detected in tool output. */
  onSecretDetected?: (event: SecretDetectionEvent) => void;
}

export interface DiffInfo {
  filePath: string;
  oldContent: string;
  newContent: string;
  isNewFile: boolean;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  diff?: DiffInfo;
  /** Optional status message for display (e.g. timeout, truncation). */
  status?: string;
}

export interface Tool {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  getDefinition(): ToolDefinition;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}
