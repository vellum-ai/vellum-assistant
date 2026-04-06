import type { ApprovalRequired } from "@vellumai/ces-contracts";

import type { CesClient } from "../credential-execution/client.js";
import type { SecretPromptResult } from "../permissions/secret-prompter.js";
import type {
  AllowlistOption,
  RiskLevel,
  ScopeOption,
} from "../permissions/types.js";
import type { ContentBlock, ToolDefinition } from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import type { SensitiveOutputBinding } from "./sensitive-output-placeholders.js";

export type ExecutionTarget = "sandbox" | "host";

interface ToolLifecycleEventBase {
  toolName: string;
  input: Record<string, unknown>;
  workingDir: string;
  conversationId: string;
  requestId?: string;
  executionTarget?: ExecutionTarget;
}

export interface ToolExecutionStartEvent extends ToolLifecycleEventBase {
  type: "start";
  startedAtMs: number;
}

export interface ToolPermissionPromptEvent extends ToolLifecycleEventBase {
  type: "permission_prompt";
  riskLevel: string;
  reason: string;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  diff?: DiffInfo;
  sandboxed?: boolean;
  persistentDecisionsAllowed?: boolean;
}

export interface ToolPermissionDeniedEvent extends ToolLifecycleEventBase {
  type: "permission_denied";
  riskLevel: string;
  decision: "deny" | "always_deny";
  reason: string;
  durationMs: number;
}

export interface ToolExecutedEvent extends ToolLifecycleEventBase {
  type: "executed";
  riskLevel: string;
  decision: string;
  durationMs: number;
  result: ToolExecutionResult;
}

export type ErrorCategory =
  | "permission_denied"
  | "auth"
  | "tool_failure"
  | "unexpected";

export interface ToolExecutionErrorEvent extends ToolLifecycleEventBase {
  type: "error";
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
  type: "secret_detected";
  matches: Array<{ type: string; redactedValue: string }>;
  action: "redact" | "warn" | "block" | "prompt";
  detectedAtMs: number;
}

export type ToolLifecycleEvent =
  | ToolExecutionStartEvent
  | ToolPermissionPromptEvent
  | ToolPermissionDeniedEvent
  | ToolExecutedEvent
  | ToolExecutionErrorEvent
  | ToolSecretDetectedEvent;

export type ToolLifecycleEventHandler = (
  event: ToolLifecycleEvent,
) => void | Promise<void>;

export type ProxyToolResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>;

export interface ToolContext {
  workingDir: string;
  conversationId: string;
  /** Logical assistant scope for multi-assistant routing. */
  assistantId?: string;
  /** When set, the tool execution is part of a task run. Used to retrieve ephemeral permission rules. */
  taskRunId?: string;
  /** Per-message request ID for log correlation across conversation/connection boundaries. */
  requestId?: string;
  /** Optional callback for streaming incremental output to the client. */
  onOutput?: (chunk: string) => void;
  /** Abort signal for cooperative cancellation. Tools should check this periodically. */
  signal?: AbortSignal;
  /** Per-conversation sandbox override. When set, takes precedence over the global config. */
  sandboxOverride?: boolean;
  /** Optional callback for tool lifecycle events (start/prompt/deny/execute/error/secret_detected). */
  onToolLifecycleEvent?: ToolLifecycleEventHandler;
  /** Optional resolver for proxy tools - delegates execution to an external client. */
  proxyToolResolver?: ProxyToolResolver;
  /** When set, only tools in this set may execute. Tools outside the set are blocked with an error. */
  allowedToolNames?: Set<string>;
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
  /** Optional callback to send a message to the connected client (e.g. open_url). */
  sendToClient?: (msg: { type: string; [key: string]: unknown }) => void;
  /** True when an interactive client is connected (not just a no-op callback). */
  isInteractive?: boolean;
  /** Memory scope ID from the conversation's memory policy, so memory tools can target the correct scope. */
  memoryScopeId?: string;
  /** When true, tools with private side-effects should always prompt for confirmation. */
  forcePromptSideEffects?: boolean;
  /**
   * When true, the tool requires a fresh interactive approval for every
   * invocation - no cached grants, temporary overrides, persistent
   * "Always Allow" rules, or non-interactive auto-approve shortcuts may
   * bypass the prompt. This flag is independently sufficient: it
   * promotes allow → prompt decisions on its own and suppresses
   * temporary override options in the prompt UI. Used by
   * `manage_secure_command_tool` to ensure a human reviews each secure
   * bundle installation.
   */
  requireFreshApproval?: boolean;
  /** Approval callback for proxy policy decisions that require user confirmation. */
  proxyApprovalCallback?: ProxyApprovalCallback;
  /** Optional principal identifier propagated to sub-tool confirmation flows. */
  principal?: string;
  /**
   * Trust classification of the actor who initiated this tool invocation.
   * Determines permission level: guardians self-approve, trusted contacts
   * may escalate to guardian for approval, unknown actors are fail-closed.
   * See {@link TrustClass} in actor-trust-resolver.ts for value semantics.
   */
  trustClass: TrustClass;
  /** Channel through which the tool invocation originates (e.g. 'telegram', 'phone'). Used for scoped grant consumption. */
  executionChannel?: string;
  /** Voice/call session ID, if the invocation originates from a call. Used for scoped grant consumption. */
  callSessionId?: string;
  /** True when the tool invocation was triggered by a user clicking a surface action button (not a regular message). */
  triggeredBySurfaceAction?: boolean;
  /** External user ID of the requester (non-guardian actor). Used for scoped grant consumption. */
  requesterExternalUserId?: string;
  /** Chat ID of the requester (non-guardian actor). Used for tool grant request escalation notifications. */
  requesterChatId?: string;
  /** Human-readable identifier for the requester (e.g., @username). */
  requesterIdentifier?: string;
  /** Preferred display name for the requester. */
  requesterDisplayName?: string;
  /** Slack channel ID for channel-scoped permission enforcement. When set, tools are checked against the channel's permission profile. */
  channelPermissionChannelId?: string;
  /** The tool_use block ID from the LLM response, used to correlate confirmation prompts with specific tool invocations. */
  toolUseId?: string;
  /** Optional proxy for delegating host_bash execution to a connected client (managed/cloud-hosted mode). */
  hostBashProxy?: import("../daemon/host-bash-proxy.js").HostBashProxy;
  /** Optional proxy for delegating host_file_read/write/edit execution to a connected client (managed/cloud-hosted mode). */
  hostFileProxy?: import("../daemon/host-file-proxy.js").HostFileProxy;
  /** True when the assistant is running as a platform-managed remote instance. Used to auto-approve sandboxed bash tools. */
  isPlatformHosted?: boolean;
  /** CES RPC client for credential execution operations. When present, the executor can bridge CES approval flows. */
  cesClient?: CesClient;
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
  /**
   * Runtime-internal sensitive output bindings (placeholder -> real value).
   * Populated by the executor when tool output contains
   * `<vellum-sensitive-output>` directives. The agent loop merges these
   * into a per-run substitution map for deterministic post-generation
   * replacement. MUST NOT be emitted in client-facing events or logs.
   */
  sensitiveBindings?: SensitiveOutputBinding[];
  /**
   * When true, the agent loop should yield control back to the user after
   * returning this result. Used by interactive surfaces (tables with action
   * buttons, file uploads) to force-stop the loop so the LLM cannot bypass
   * the "wait for user action" instruction.
   */
  yieldToUser?: boolean;
  /**
   * When present, indicates that a CES tool returned an `approval_required`
   * response. The executor uses the approval bridge to prompt the guardian,
   * commit the grant decision to CES, and retry the original tool invocation
   * with the granted grantId. CES tools populate this field rather than
   * returning a textual error so the executor can intercept and handle the
   * approval flow transparently.
   */
  cesApprovalRequired?: ApprovalRequired;
}

// ---------------------------------------------------------------------------
// Proxy approval types - local definitions for the outbound-proxy contract.
// The proxy service owns the canonical shapes; these are the assistant's
// minimal view of the approval callback interface.
// ---------------------------------------------------------------------------

/** Approval request from the outbound proxy when a policy decision requires user confirmation. */
export interface ProxyApprovalRequest {
  decision: {
    kind: "ask_missing_credential" | "ask_unauthenticated";
    target: {
      hostname: string;
      port: number | null;
      path: string;
      scheme: "http" | "https";
    };
    /** Present when kind is "ask_missing_credential". */
    matchingPatterns?: string[];
  };
  sessionId: string;
}

/** Callback for proxy policy decisions requiring user confirmation. Returns true if approved. */
export type ProxyApprovalCallback = (
  request: ProxyApprovalRequest,
) => Promise<boolean>;

/** Env vars a proxy session injects into child processes. */
export interface ProxyEnvVars {
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
  NO_PROXY: string;
  NODE_EXTRA_CA_CERTS?: string;
  SSL_CERT_FILE?: string;
}

export interface Tool {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  /** When set to 'proxy', the tool is forwarded to a connected client rather than executed locally. */
  executionMode?: "local" | "proxy";
  /** Whether this tool is a core built-in, provided by a skill, or from an MCP server. */
  origin?: "core" | "skill" | "mcp";
  /** If origin is 'skill', the ID of the owning skill. */
  ownerSkillId?: string;
  /** If origin is 'mcp', the ID of the owning MCP server. */
  ownerMcpServerId?: string;
  /** Content-hash of the owning skill's source at registration time. */
  ownerSkillVersionHash?: string;
  /** Whether the owning skill is bundled with the daemon (trusted first-party). */
  ownerSkillBundled?: boolean;
  /** Declared execution target from the skill manifest. Used by resolveExecutionTarget
   * to accurately label lifecycle events for skill-provided tools. */
  executionTarget?: ExecutionTarget;
  getDefinition(): ToolDefinition;
  execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult>;
}
