import type { RiskLevel, AllowlistOption, ScopeOption } from '../permissions/types.js';
import type { ToolDefinition } from '../providers/types.js';

interface ToolLifecycleEventBase {
  toolName: string;
  input: Record<string, unknown>;
  workingDir: string;
  sessionId: string;
  conversationId: string;
  requestId?: string;
}

export interface ToolExecutionStartEvent extends ToolLifecycleEventBase {
  type: 'start';
  startedAtMs: number;
}

export interface ToolPermissionPromptEvent extends ToolLifecycleEventBase {
  type: 'permission_prompt';
  riskLevel: string;
  reason: string;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  diff?: DiffInfo;
  sandboxed?: boolean;
}

export interface ToolPermissionDeniedEvent extends ToolLifecycleEventBase {
  type: 'permission_denied';
  riskLevel: string;
  decision: 'deny' | 'always_deny';
  reason: string;
  durationMs: number;
}

export interface ToolExecutedEvent extends ToolLifecycleEventBase {
  type: 'executed';
  riskLevel: string;
  decision: string;
  durationMs: number;
  result: ToolExecutionResult;
}

export interface ToolExecutionErrorEvent extends ToolLifecycleEventBase {
  type: 'error';
  riskLevel: string;
  decision: string;
  durationMs: number;
  errorMessage: string;
  isExpected: boolean;
  errorName?: string;
  errorStack?: string;
}

export interface ToolSecretDetectedEvent extends ToolLifecycleEventBase {
  type: 'secret_detected';
  matches: Array<{ type: string; redactedValue: string }>;
  action: 'redact' | 'warn' | 'block';
  detectedAtMs: number;
}

export type ToolLifecycleEvent =
  | ToolExecutionStartEvent
  | ToolPermissionPromptEvent
  | ToolPermissionDeniedEvent
  | ToolExecutedEvent
  | ToolExecutionErrorEvent
  | ToolSecretDetectedEvent;

export type ToolLifecycleEventHandler = (event: ToolLifecycleEvent) => void | Promise<void>;

export type ProxyToolResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>;

export interface ToolContext {
  workingDir: string;
  sessionId: string;
  conversationId: string;
  /** Per-message request ID for log correlation across session/connection boundaries. */
  requestId?: string;
  /** Optional callback for streaming incremental output to the client. */
  onOutput?: (chunk: string) => void;
  /** Per-session sandbox override. When set, takes precedence over the global config. */
  sandboxOverride?: boolean;
  /** Optional callback for tool lifecycle events (start/prompt/deny/execute/error/secret_detected). */
  onToolLifecycleEvent?: ToolLifecycleEventHandler;
  /** Optional resolver for proxy tools — delegates execution to an external client. */
  proxyToolResolver?: ProxyToolResolver;
  /** Request user confirmation for a sub-tool operation (used by claude_code tool). */
  requestConfirmation?: (req: {
    toolName: string;
    input: Record<string, unknown>;
    riskLevel: string;
  }) => Promise<{ decision: 'allow' | 'deny' }>;
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
  /** When set to 'proxy', the tool is forwarded to a connected client rather than executed locally. */
  executionMode?: 'local' | 'proxy';
  getDefinition(): ToolDefinition;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}
