import type { ApprovalRequired } from "@vellumai/service-contracts/credential-rpc";
import type {
  DiffInfo,
  ExecutionTarget,
  ProxyApprovalCallback,
  RiskLevel,
  SensitiveOutputBinding,
  ToolDefinition,
  ToolExecutionErrorEvent,
  ToolExecutionStartEvent,
  ToolPermissionDeniedEvent,
  ToolPermissionPromptEvent,
} from "@vellumai/skill-host-contracts";

import type { InterfaceId } from "../channels/types.js";
import type { CesClient } from "../credential-execution/client.js";
import type { SecretPromptResult } from "../permissions/secret-prompter.js";
import type { ContentBlock } from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";

export const DISK_PRESSURE_CLEANUP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "host_bash",
  "file_read",
  "file_list",
  "host_file_read",
  "background_tool_list",
  "background_tool_cancel",
]);

export function isDiskPressureCleanupToolName(name: string): boolean {
  return DISK_PRESSURE_CLEANUP_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Re-exports + concrete overlays for types that live in
// @vellumai/skill-host-contracts.
//
// The canonical declarations moved into the neutral contracts package as
// part of the skill-isolation work. This file preserves existing import
// paths (`"../tools/types.js"`) so all callers keep resolving.
//
// Pure re-exports below cover types the contracts package could declare
// without any assistant-side references. The remaining interfaces (`Tool`,
// `ToolContext`, `ToolExecutionResult`, `ToolExecutedEvent`,
// `ToolLifecycleEvent`, `ToolLifecycleEventHandler`, `ProxyToolResolver`)
// reference daemon-internal types (CES client, host-proxy classes,
// `ContentBlock`, `ApprovalRequired`, `TrustClass`, `InterfaceId`,
// `SecretPromptResult`) that can't move into a neutral package. For those,
// the contracts version uses opaque placeholders (`unknown`, broadened
// `string`) and the assistant redeclares the interface here with the
// concrete types. The two sides are structurally independent — no
// inheritance, no intersection — which avoids TypeScript's contravariance
// mismatches on lifecycle-event handlers.
// ---------------------------------------------------------------------------

export type {
  DiffInfo,
  ErrorCategory,
  ExecutionTarget,
  ProxyApprovalCallback,
  ProxyApprovalRequest,
  ProxyEnvVars,
  SensitiveOutputBinding,
  SensitiveOutputKind,
  ToolDefinition,
  ToolExecutionErrorEvent,
  ToolExecutionStartEvent,
  ToolPermissionDeniedEvent,
  ToolPermissionPromptEvent,
} from "@vellumai/skill-host-contracts";
export { RiskLevel } from "@vellumai/skill-host-contracts";

// ---------------------------------------------------------------------------
// Assistant-side concrete overlays
// ---------------------------------------------------------------------------

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
   * returning this result — tool results are pushed to history and the loop
   * breaks without another LLM call. Two callers set this: interactive
   * surfaces (tables with action buttons, file uploads) that force-stop the
   * loop so the LLM cannot bypass the "wait for user action" instruction,
   * and tools like `remember` that expose a `finish_turn` parameter letting
   * the LLM voluntarily end its turn.
   */
  yieldToUser?: boolean;
  /** Risk level from the classifier (populated during permission check). */
  riskLevel?: string;
  /** Human-readable reason for the risk classification. */
  riskReason?: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** How the decision was reached: prompted, auto, blocked, or unknown (legacy). */
  approvalMode?: string;
  /** Why the decision was reached (stable enum for client display). */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at the time of execution. */
  riskThreshold?: string;
  /** Whether the daemon is running in a containerized (Docker) environment. */
  isContainerized?: boolean;
  /** Scope options ladder for the rule editor (narrowest to broadest). */
  riskScopeOptions?: Array<{ pattern: string; label: string }>;
  /** Directory scope ladder for the rule editor (narrowest to broadest). */
  riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
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

export type ProxyToolResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>;

/**
 * `ToolExecutedEvent` carries a `result: ToolExecutionResult` field, so
 * the assistant re-declares it here to reference the assistant-side
 * `ToolExecutionResult` (which narrows `contentBlocks` to `ContentBlock[]`
 * and `cesApprovalRequired` to `ApprovalRequired`).
 */
export interface ToolExecutedEvent {
  type: "executed";
  toolName: string;
  input: Record<string, unknown>;
  workingDir: string;
  conversationId: string;
  requestId?: string;
  executionTarget?: ExecutionTarget;
  riskLevel: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** How the approval decision was reached. Copied from PermissionDecision for analytics consumers. */
  approvalMode?: string;
  /** Why the approval decision was reached (stable enum). Copied from PermissionDecision for analytics consumers. */
  approvalReason?: string;
  decision: string;
  durationMs: number;
  result: ToolExecutionResult;
}

export type ToolLifecycleEvent =
  | ToolExecutionStartEvent
  | ToolPermissionPromptEvent
  | ToolPermissionDeniedEvent
  | ToolExecutedEvent
  | ToolExecutionErrorEvent;

export type ToolLifecycleEventHandler = (
  event: ToolLifecycleEvent,
) => void | Promise<void>;

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
  /** Optional callback for tool lifecycle events (start/prompt/deny/execute/error). */
  onToolLifecycleEvent?: ToolLifecycleEventHandler;
  /** Optional resolver for proxy tools - delegates execution to an external client. */
  proxyToolResolver?: ProxyToolResolver;
  /** When set, only tools in this set may execute. Tools outside the set are blocked with an error. */
  allowedToolNames?: Set<string>;
  /** True when this turn is restricted to storage cleanup-safe tools. */
  diskPressureCleanupModeActive?: boolean;
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
  /** When true, tools with side effects should always prompt for confirmation. */
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
  /** True when the user explicitly approved this tool invocation via the interactive permission prompt (not auto-approved by trust rules or temporary overrides). */
  approvedViaPrompt?: boolean;
  /**
   * True when the invocation is inside a scheduled task run whose
   * `required_tools` array pre-authorized this tool at task-creation time.
   * Tools that normally require a surface-action click (e.g. bulk archive,
   * unsubscribe) may treat this as equivalent consent, since the user
   * already reviewed the tool list when the task was saved.
   */
  batchAuthorizedByTask?: boolean;
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
  /** True when the assistant is running as a platform-managed remote instance. Used to auto-approve sandboxed bash tools. */
  isPlatformHosted?: boolean;
  /** CES RPC client for credential execution operations. When present, the executor can bridge CES approval flows. */
  cesClient?: CesClient;
  /**
   * The interface ID of the connected client driving the current turn (e.g.
   * "macos", "chrome-extension"). Browser backend policy uses this to decide
   * transport preference — for example, macOS-originated turns prefer the
   * user's real Chrome session via the paired extension before falling back
   * to cdp-inspect or local Playwright.
   */
  transportInterface?: InterfaceId;
  /**
   * The per-turn inference-profile override the agent loop is currently
   * running under, propagated through tool context so subagent-spawn tools
   * can forward it when spawning nested subagents. Without this, sub-subagent
   * spawns silently lose inheritance because their own conversation row never
   * has `inferenceProfile` set — the override only flows through the
   * in-memory `SubagentConfig.overrideProfile` chain. See
   * `executeSubagentSpawn` in tools/subagent/spawn.ts.
   */
  overrideProfile?: string;
  /**
   * Canonical principal ID of the actor on whose behalf this tool invocation
   * is running. Sourced from `conversation.trustContext.guardianPrincipalId`.
   * Used by host proxies to bind cross-client targeted execution to the same
   * authenticated user identity. May be undefined for legacy/internal flows
   * with no resolved actor identity.
   */
  sourceActorPrincipalId?: string;
}

export interface Tool {
  name: string;
  description: string;
  category: string;
  defaultRiskLevel: RiskLevel;
  /** When set to 'proxy', the tool is forwarded to a connected client rather than executed locally. */
  executionMode?: "local" | "proxy";
  /** Whether this tool is a core built-in, provided by a skill, contributed by a plugin, or from an MCP server. */
  origin?: "core" | "skill" | "mcp" | "plugin";
  /** If origin is 'skill', the ID of the owning skill. */
  ownerSkillId?: string;
  /** If origin is 'mcp', the ID of the owning MCP server. */
  ownerMcpServerId?: string;
  /** If origin is 'plugin', the name of the owning plugin. */
  ownerPluginId?: string;
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
