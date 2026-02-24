import type { RiskLevel, AllowlistOption, ScopeOption } from '../permissions/types.js';
import type { ToolDefinition, ContentBlock } from '../providers/types.js';
import type { SecretPromptResult } from '../permissions/secret-prompter.js';

export type ExecutionTarget = 'sandbox' | 'host';

interface ToolLifecycleEventBase {
  toolName: string;
  input: Record<string, unknown>;
  workingDir: string;
  sessionId: string;
  conversationId: string;
  requestId?: string;
  executionTarget?: ExecutionTarget;
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
  persistentDecisionsAllowed?: boolean;
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

export type ErrorCategory = 'permission_denied' | 'auth' | 'tool_failure' | 'unexpected';

export interface ToolExecutionErrorEvent extends ToolLifecycleEventBase {
  type: 'error';
  riskLevel: string;
  decision: string;
  durationMs: number;
  errorMessage: string;
  isExpected: boolean;
  /** Classifies the error for downstream consumers (audit, alerting, monitoring). */
  errorCategory: ErrorCategory;
  errorName?: string;
  errorStack?: string;
}

export interface ToolSecretDetectedEvent extends ToolLifecycleEventBase {
  type: 'secret_detected';
  matches: Array<{ type: string; redactedValue: string }>;
  action: 'redact' | 'warn' | 'block' | 'prompt';
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
  /** Logical assistant scope for multi-assistant routing. */
  assistantId?: string;
  /** When set, the tool execution is part of a task run. Used to retrieve ephemeral permission rules. */
  taskRunId?: string;
  /** Per-message request ID for log correlation across session/connection boundaries. */
  requestId?: string;
  /** Optional callback for streaming incremental output to the client. */
  onOutput?: (chunk: string) => void;
  /** Abort signal for cooperative cancellation. Tools should check this periodically. */
  signal?: AbortSignal;
  /** Per-session sandbox override. When set, takes precedence over the global config. */
  sandboxOverride?: boolean;
  /** Optional callback for tool lifecycle events (start/prompt/deny/execute/error/secret_detected). */
  onToolLifecycleEvent?: ToolLifecycleEventHandler;
  /** Optional resolver for proxy tools — delegates execution to an external client. */
  proxyToolResolver?: ProxyToolResolver;
  /** When set, only tools in this set may execute. Tools outside the set are blocked with an error. */
  allowedToolNames?: Set<string>;
  /** Request user confirmation for a sub-tool operation (used by claude_code tool). */
  requestConfirmation?: (req: {
    toolName: string;
    input: Record<string, unknown>;
    riskLevel: string;
    executionTarget?: ExecutionTarget;
    principal?: string;
  }) => Promise<{ decision: 'allow' | 'deny' }>;
  /** Prompt the user for a secret value via native SecureField UI. */
  requestSecret?: (params: {
    service: string;
    field: string;
    label: string;
    description?: string;
    placeholder?: string;
    purpose?: string;
    allowedTools?: string[];
    allowedDomains?: string[];
  }) => Promise<SecretPromptResult>;
  /** Optional callback to send a message to the connected IPC client (e.g. open_url). */
  sendToClient?: (msg: { type: string; [key: string]: unknown }) => void;
  /** True when an interactive IPC client is connected (not just a no-op callback). */
  isInteractive?: boolean;
  /** Memory scope ID from the session's memory policy, so memory tools can target the correct scope. */
  memoryScopeId?: string;
  /** When true, tools with private side-effects should always prompt for confirmation. */
  forcePromptSideEffects?: boolean;
  /** Approval callback for proxy policy decisions that require user confirmation. */
  proxyApprovalCallback?: import('./network/script-proxy/types.js').ProxyApprovalCallback;
  /** Optional principal identifier propagated to sub-tool confirmation flows. */
  principal?: string;
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
  /** Optional rich content blocks (e.g. images) to include alongside text in the tool result. */
  contentBlocks?: ContentBlock[];
}

export interface Tool {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  /** When set to 'proxy', the tool is forwarded to a connected client rather than executed locally. */
  executionMode?: 'local' | 'proxy';
  /** Whether this tool is a core built-in or provided by a skill. */
  origin?: 'core' | 'skill';
  /** If origin is 'skill', the ID of the owning skill. */
  ownerSkillId?: string;
  /** Content-hash of the owning skill's source at registration time. */
  ownerSkillVersionHash?: string;
  /** Whether the owning skill is bundled with the daemon (trusted first-party). */
  ownerSkillBundled?: boolean;
  /** Declared execution target from the skill manifest. Used by resolveExecutionTarget
   * to accurately label lifecycle events for skill-provided tools. */
  executionTarget?: ExecutionTarget;
  getDefinition(): ToolDefinition;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
}
