/**
 * Tool definitions and executor setup extracted from Conversation constructor.
 *
 * The Conversation constructor delegates tool definition building and tool
 * executor callback creation to the helper functions exported here,
 * keeping the constructor body focused on wiring.
 */

import {
  type HostProxyCapability,
  type InterfaceId,
  supportsHostProxy,
} from "../channels/types.js";
import { isHttpAuthDisabled } from "../config/env.js";
import { getIsPlatform } from "../config/env-registry.js";
import type { CesClient } from "../credential-execution/client.js";
import { getBindingByConversation } from "../memory/external-conversation-store.js";
import {
  generateAllowlistOptions,
  generateScopeOptions,
  normalizeWebFetchUrl,
} from "../permissions/checker.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import {
  addRule,
  findHighestPriorityRule,
} from "../permissions/trust-store.js";
import { isAllowDecision } from "../permissions/types.js";
import { isPermissionControlsV2Enabled } from "../permissions/v2-consent-policy.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { coreAppProxyTools } from "../tools/apps/definitions.js";
import { registerConversationSender } from "../tools/browser/browser-screencast.js";
import type { ToolExecutor } from "../tools/executor.js";
import {
  getAllToolDefinitions,
  getMcpToolDefinitions,
} from "../tools/registry.js";
import {
  ACTIVITY_SKIP_SET,
  injectActivityField,
} from "../tools/schema-transforms.js";
import type {
  ProxyApprovalCallback,
  ProxyApprovalRequest,
  ToolContext,
  ToolExecutionResult,
  ToolLifecycleEventHandler,
} from "../tools/types.js";
import { allUiSurfaceTools } from "../tools/ui-surface/definitions.js";
import { getLogger } from "../util/logger.js";
import type { TrustContext } from "./conversation-runtime-assembly.js";
import {
  projectSkillTools,
  type SkillProjectionCache,
} from "./conversation-skill-tools.js";
import type { SurfaceConversationContext } from "./conversation-surfaces.js";
import { surfaceProxyResolver } from "./conversation-surfaces.js";
import {
  isDoordashCommand,
  markDoordashStepInProgress,
} from "./doordash-steps.js";
import type { ServerMessage, UiSurfaceShow } from "./message-protocol.js";
import { runPostExecutionSideEffects } from "./tool-side-effects.js";

const log = getLogger("conversation-tool-setup");

/**
 * Resolve the effective trust class for tool execution.
 *
 * When HTTP auth is disabled (dev bypass), always returns `'guardian'`
 * so that control-plane gates don't block local development.
 *
 * When no trust context is available (e.g. desktop-only conversations that
 * don't go through channel trust resolution), defaults to `'unknown'`
 * to fail-closed.
 */
export function resolveTrustClass(
  trustContext: TrustContext | undefined,
): TrustClass {
  if (isHttpAuthDisabled()) return "guardian";
  return trustContext?.trustClass ?? "unknown";
}

// ── Context Interface ────────────────────────────────────────────────

/**
 * Subset of Conversation state that the tool executor callback reads at
 * call time (not construction time). These are captured by the
 * returned closure, so they must be live references.
 */
export interface ToolSetupContext extends SurfaceConversationContext {
  readonly conversationId: string;
  assistantId?: string;
  currentRequestId?: string;
  workingDir: string;
  abortController: AbortController | null;
  /** When set, only tools in this set may execute during the current turn. */
  allowedToolNames?: Set<string>;
  /** Conversation memory policy — used to propagate scopeId and strictSideEffects into ToolContext. */
  memoryPolicy: { scopeId: string; strictSideEffects: boolean };
  /** True when the conversation has no connected client (HTTP-only path). */
  hasNoClient?: boolean;
  /** When true, the conversation is executing a task run and must not become interactive. */
  headlessLock?: boolean;
  /** When set, this conversation is executing a task run. Used to retrieve ephemeral permission rules. */
  taskRunId?: string;
  /** Guardian runtime context for the conversation — trustClass is propagated into ToolContext for control-plane policy enforcement. */
  trustContext?: TrustContext;
  /** Voice/call session ID, if the conversation originates from a call. Propagated into ToolContext for scoped grant consumption. */
  callSessionId?: string;
  /** Optional proxy for delegating host_bash execution to a connected client. */
  hostBashProxy?: import("./host-bash-proxy.js").HostBashProxy;
  /** Optional proxy for delegating CDP commands to a connected client (managed/cloud-hosted mode). */
  hostBrowserProxy?: import("./host-browser-proxy.js").HostBrowserProxy;
  /** Optional proxy for delegating host_file_read/write/edit execution to a connected client. */
  hostFileProxy?: import("./host-file-proxy.js").HostFileProxy;
  /** CES RPC client for credential execution operations. Injected when CES tools are enabled and the CES process is available. */
  cesClient?: CesClient;
}

// ── buildToolDefinitions ─────────────────────────────────────────────

/**
 * Collect all tool definitions for the agent loop: built-in tools,
 * UI surface proxy tools, and app proxy tools.
 */
export function buildToolDefinitions(): ToolDefinition[] {
  return [
    ...getAllToolDefinitions(),
    ...allUiSurfaceTools.map((t) => t.getDefinition()),
    ...coreAppProxyTools.map((t) => t.getDefinition()),
  ];
}

// ── createToolExecutor ───────────────────────────────────────────────

/**
 * Build the tool executor callback that the AgentLoop calls for each
 * tool_use block. The returned function closes over `ctx` so it sees
 * live Conversation state (workingDir, currentRequestId, abortController,
 * etc.) at invocation time.
 */
export function createToolExecutor(
  executor: ToolExecutor,
  prompter: PermissionPrompter,
  secretPrompter: SecretPrompter,
  ctx: ToolSetupContext,
  handleToolLifecycleEvent: ToolLifecycleEventHandler,
  broadcastToAllClients?: (msg: ServerMessage) => void,
): (
  name: string,
  input: Record<string, unknown>,
  onOutput?: (chunk: string) => void,
  toolUseId?: string,
) => Promise<ToolExecutionResult> {
  // Register the conversation's sendToClient for browser screencast surface messages
  registerConversationSender(ctx.conversationId, (msg) =>
    ctx.sendToClient(msg),
  );

  return async (
    name: string,
    input: Record<string, unknown>,
    onOutput?: (chunk: string) => void,
    toolUseId?: string,
  ) => {
    if (isDoordashCommand(name, input)) {
      markDoordashStepInProgress(ctx, input);
    }

    // Build the context object shared by both the skill_execute interception
    // path and the regular executor path.
    const toolContext: ToolContext = {
      workingDir: ctx.workingDir,
      conversationId: ctx.conversationId,
      assistantId: ctx.assistantId,
      requestId: ctx.currentRequestId,
      taskRunId: ctx.taskRunId,
      trustClass: resolveTrustClass(ctx.trustContext),
      executionChannel: ctx.trustContext?.sourceChannel,
      callSessionId: ctx.callSessionId,
      triggeredBySurfaceAction:
        ctx.surfaceActionRequestIds?.has(ctx.currentRequestId ?? "") ?? false,
      requesterExternalUserId: ctx.trustContext?.requesterExternalUserId,
      requesterChatId: ctx.trustContext?.requesterChatId,
      requesterIdentifier: ctx.trustContext?.requesterIdentifier,
      requesterDisplayName: ctx.trustContext?.requesterDisplayName,
      channelPermissionChannelId:
        ctx.trustContext?.sourceChannel === "slack"
          ? getBindingByConversation(ctx.conversationId)?.externalChatId
          : undefined,
      onOutput,
      signal: ctx.abortController?.signal,
      allowedToolNames: ctx.allowedToolNames,
      memoryScopeId: ctx.memoryPolicy.scopeId,
      forcePromptSideEffects: ctx.memoryPolicy.strictSideEffects,
      toolUseId,
      hostBashProxy: ctx.hostBashProxy,
      hostBrowserProxy: ctx.hostBrowserProxy,
      hostFileProxy: ctx.hostFileProxy,
      isPlatformHosted: getIsPlatform(),
      cesClient: ctx.cesClient,
      onToolLifecycleEvent: handleToolLifecycleEvent,
      sendToClient: (msg) => {
        // Tool context's sendToClient uses a loose { type: string; [key: string]: unknown }
        // signature, but at runtime these are always ServerMessage instances.
        ctx.sendToClient(msg as ServerMessage);
        if (msg.type === "ui_surface_show") {
          const s = msg as unknown as UiSurfaceShow;
          ctx.currentTurnSurfaces.push({
            surfaceId: s.surfaceId,
            surfaceType: s.surfaceType,
            title: s.title,
            data: s.data,
            actions: s.actions,
            display: s.display,
          });
        }
      },
      isInteractive: !ctx.hasNoClient && !ctx.headlessLock,
      proxyToolResolver: (
        toolName: string,
        proxyInput: Record<string, unknown>,
      ) =>
        surfaceProxyResolver(
          ctx,
          toolName,
          proxyInput,
          ctx.abortController?.signal,
        ),
      proxyApprovalCallback: createProxyApprovalCallback(prompter, ctx),
      requestSecret: async (params) => {
        return secretPrompter.prompt(
          params.service,
          params.field,
          params.label,
          params.description,
          params.placeholder,
          ctx.conversationId,
          params.purpose,
          params.allowedTools,
          params.allowedDomains,
        );
      },
    };

    // Intercept skill_execute: extract the real tool name and input, then
    // route through the full executor pipeline so the underlying tool's
    // risk level, permission checks, hooks, and lifecycle events all fire
    // with the real tool name.
    if (name === "skill_execute") {
      const toolName = typeof input.tool === "string" ? input.tool : "";
      const rawToolInput =
        input.input != null && typeof input.input === "object"
          ? (input.input as Record<string, unknown>)
          : {};

      // Clone to avoid mutating shared input objects
      const toolInput = { ...rawToolInput };

      // Propagate outer activity when inner input lacks a valid one
      if (
        typeof input.activity === "string" &&
        input.activity &&
        (typeof toolInput.activity !== "string" ||
          toolInput.activity.length === 0)
      ) {
        toolInput.activity = input.activity;
      }

      if (!toolName) {
        return {
          content:
            'Error: skill_execute requires a "tool" parameter with the tool name',
          isError: true,
        };
      }

      const result = await executor.execute(toolName, toolInput, toolContext);

      runPostExecutionSideEffects(toolName, toolInput, result, {
        ctx,
        broadcastToAllClients,
      });

      return result;
    }

    const result = await executor.execute(name, input, toolContext);

    runPostExecutionSideEffects(name, input, result, {
      ctx,
      broadcastToAllClients,
    });

    return result;
  };
}

// ── createProxyApprovalCallback ──────────────────────────────────────

/**
 * Build a proxy approval callback that routes `ask_missing_credential` and
 * `ask_unauthenticated` policy decisions through the existing permission
 * prompter UI. The proxy service calls this when an outbound request needs
 * user confirmation before proceeding.
 */
export function createProxyApprovalCallback(
  prompter: PermissionPrompter,
  ctx: ToolSetupContext,
): ProxyApprovalCallback {
  return async (request: ProxyApprovalRequest): Promise<boolean> => {
    const { decision } = request;
    const { hostname, port, path } = decision.target;

    // Use the standard network_request tool name so trust rules align with
    // the checker's URL-based candidate generation and allowlist options.
    const toolName = "network_request";
    const { scheme } = decision.target;
    const url = `${scheme}://${hostname}${port ? ":" + port : ""}${path}`;

    if (isPermissionControlsV2Enabled()) {
      return false;
    }

    const input: Record<string, unknown> = {
      url,
      proxy_session_id: request.sessionId,
    };
    if (decision.kind === "ask_missing_credential") {
      input.matching_patterns = decision.matchingPatterns;
    }

    const riskLevel: string = "medium";

    // Check trust store before prompting — build candidates that mirror
    // buildCommandCandidates() in checker.ts for network_request.
    const candidates: string[] = [`${toolName}:${url}`];
    const normalized = normalizeWebFetchUrl(url);
    if (normalized) {
      candidates.push(`${toolName}:${normalized.href}`);
      candidates.push(`${toolName}:${normalized.origin}/*`);
    }
    candidates.push(`${toolName}:*`);
    // Deduplicate
    const uniqueCandidates = [...new Set(candidates)];

    const existingRule = findHighestPriorityRule(
      toolName,
      uniqueCandidates,
      ctx.workingDir,
    );
    if (existingRule && existingRule.decision !== "ask") {
      if (existingRule.decision === "deny") return false;
      return true;
    }

    // Use the checker's built-in allowlist generation for network_request
    const allowlistOptions = await generateAllowlistOptions("network_request", {
      url,
    });

    const scopeOptions = generateScopeOptions(ctx.workingDir);

    // Non-interactive conversations have no client to prompt — fast-deny to avoid
    // blocking for the full permission timeout before auto-denying.
    if (ctx.hasNoClient) {
      return false;
    }

    // Proxied network requests require per-invocation approval and must
    // not be auto-approved by temporary overrides (allow_10m / allow_conversation).
    // Unlike regular tool invocations, these represent outbound network
    // actions that should always receive explicit confirmation.

    const response = await prompter.prompt(
      toolName,
      input,
      riskLevel,
      allowlistOptions,
      scopeOptions,
      undefined,
      ctx.conversationId,
    );

    // Persist trust rule if the user chose "always allow" or "always deny"
    if (
      (response.decision === "always_allow" ||
        response.decision === "always_allow_high_risk") &&
      response.selectedPattern &&
      response.selectedScope
    ) {
      const allowHighRisk = response.decision === "always_allow_high_risk";
      log.info(
        {
          toolName,
          pattern: response.selectedPattern,
          scope: response.selectedScope,
          allowHighRisk,
        },
        "Persisting always-allow trust rule (proxy)",
      );
      addRule(
        toolName,
        response.selectedPattern,
        response.selectedScope,
        "allow",
        100,
        allowHighRisk ? { allowHighRisk: true } : undefined,
      );
    }
    if (
      response.decision === "always_deny" &&
      response.selectedPattern &&
      response.selectedScope
    ) {
      log.info(
        {
          toolName,
          pattern: response.selectedPattern,
          scope: response.selectedScope,
        },
        "Persisting always-deny trust rule (proxy)",
      );
      addRule(
        toolName,
        response.selectedPattern,
        response.selectedScope,
        "deny",
      );
    }

    return isAllowDecision(response.decision);
  };
}

// ── createResolveToolsCallback ───────────────────────────────────────

/**
 * Bundled skills that must always be active regardless of conversation
 * history or explicit preactivation. Without this, their tools are
 * unavailable in fresh conversations until `skill_load` is called.
 */
const DEFAULT_PREACTIVATED_SKILL_IDS = ["tasks", "notifications", "subagent"];

/**
 * Subset of Conversation state that the resolveTools callback reads at each
 * agent turn. Properties are read lazily from this reference.
 */
export interface SkillProjectionContext {
  preactivatedSkillIds?: string[];
  readonly skillProjectionState: Map<string, string>;
  readonly skillProjectionCache: SkillProjectionCache;
  readonly coreToolNames: Set<string>;
  allowedToolNames?: Set<string>;
  /** When > 0, the resolveTools callback returns no tools at all. */
  toolsDisabledDepth: number;
  /** Channel capabilities — read lazily per turn for conditional tool filtering. */
  readonly channelCapabilities?: {
    channel: string;
    supportsDynamicUi: boolean;
    clientOS?: string;
  };
  /** True when no client is connected (HTTP-only). */
  readonly hasNoClient?: boolean;
  /** When set, only tools in this set are included in the resolved tool list (subagent delegation). */
  subagentAllowedTools?: Set<string>;
  /** True when this conversation belongs to a subagent spawned by SubagentManager. */
  readonly isSubagent?: boolean;
  /**
   * The interface id of the connected client driving the current turn (e.g.
   * "macos", "chrome-extension"). Used to gate host tools by per-capability
   * `supportsHostProxy(transport, capability)` so that interfaces which only
   * support a subset of the host proxy set (e.g. chrome-extension supports
   * `host_browser` but not `host_bash`/`host_file`) do not leak unsupported
   * host tools into the LLM tool definitions.
   */
  readonly transportInterface?: InterfaceId;
}

// ── Conditional tool sets ────────────────────────────────────────────

const UI_SURFACE_TOOL_NAMES = new Set(["ui_show", "ui_update", "ui_dismiss"]);
/**
 * Single source of truth for which tools are host tools and the capability
 * each one requires from the connected client interface. Adding a tool here
 * automatically adds it to `HOST_TOOL_NAMES` below, so the two collections
 * cannot drift apart: if a new host tool is added without a capability
 * mapping, `isToolActiveForContext` cannot accidentally return `true` for
 * chrome-extension (or any other partial-capability transport) because
 * `HOST_TOOL_NAMES` wouldn't contain it either.
 *
 * `isToolActiveForContext` uses this map to gate each host tool individually
 * so that partial-capability transports (e.g. chrome-extension only supports
 * `host_browser`) only see the host tools their interface can actually
 * service.
 *
 * Note: there is no `host_cu` tool exposed via the tool gating layer today;
 * computer-use is preactivated as a skill and projected through the skill
 * tools path. Only host tools that flow through the per-capability gate
 * need entries here.
 */
export const HOST_TOOL_TO_CAPABILITY = new Map<string, HostProxyCapability>([
  ["host_bash", "host_bash"],
  ["host_file_read", "host_file"],
  ["host_file_write", "host_file"],
  ["host_file_edit", "host_file"],
  ["host_browser", "host_browser"],
]);
// Derived from HOST_TOOL_TO_CAPABILITY so the invariant "every host tool has
// a capability mapping" is a structural fact — no runtime assertion needed.
export const HOST_TOOL_NAMES = new Set(HOST_TOOL_TO_CAPABILITY.keys());
const CLIENT_CAPABILITY_TOOL_NAMES = new Set(["app_open"]);
const PLATFORM_TOOL_NAMES = new Set(["request_system_permission"]);

/**
 * Tools that should only be visible to subagent conversations. Main (parent)
 * conversations never see these in the LLM tool definitions. Subsequent PRs
 * will populate this set; it starts empty so there is no behavioral change.
 */
export const SUBAGENT_ONLY_TOOL_NAMES = new Set<string>([
  "file_list",
  "notify_parent",
]);

/**
 * Determine whether a tool should be included in the LLM tool definitions
 * for the current turn based on conversation context. Tools not active for the
 * current context are omitted from the definitions sent to the provider,
 * reducing noise and preventing the model from attempting calls that would
 * fail.
 */
export function isToolActiveForContext(
  name: string,
  ctx: SkillProjectionContext,
): boolean {
  if (UI_SURFACE_TOOL_NAMES.has(name)) {
    return ctx.channelCapabilities?.supportsDynamicUi ?? !ctx.hasNoClient;
  }
  if (HOST_TOOL_NAMES.has(name)) {
    const capability = HOST_TOOL_TO_CAPABILITY.get(name);
    const transport = ctx.transportInterface;

    // Per-capability check is authoritative for structural support: if the
    // transport cannot service this capability, the tool is filtered out.
    if (transport && capability && !supportsHostProxy(transport, capability)) {
      return false;
    }

    // chrome-extension is its own executor — the extension's popup gates
    // commands via its own UI, and the transport does not use an SSE-level
    // interactive approval channel. hasNoClient is intentionally `true` for
    // chrome-extension turns (chrome-extension is not in INTERACTIVE_INTERFACES)
    // and must not gate host_browser. Trust the per-capability check.
    if (transport === "chrome-extension") {
      return true;
    }

    // For transports that surface approvals over SSE (macos, backwards-compat
    // fallback), deny when no client is present so the guardian auto-approve
    // path cannot execute host commands unattended.
    return !ctx.hasNoClient;
  }
  if (CLIENT_CAPABILITY_TOOL_NAMES.has(name)) {
    return !ctx.hasNoClient;
  }
  if (PLATFORM_TOOL_NAMES.has(name)) {
    // Check the *client's* platform, not the daemon's process.platform.
    // In Docker the daemon runs on Linux but the connected client may be macOS.
    return ctx.channelCapabilities?.clientOS === "macos" && !ctx.hasNoClient;
  }
  if (SUBAGENT_ONLY_TOOL_NAMES.has(name)) {
    return ctx.isSubagent === true;
  }
  return true;
}

/**
 * Build a resolveTools callback that merges base tool definitions with
 * dynamically projected skill tools on each agent turn. Also updates
 * allowedToolNames so newly-activated skill tools aren't blocked by
 * the executor's stale gate.
 *
 * Core (non-MCP) tool definitions are captured at conversation creation and
 * reused on each turn. MCP tool definitions are re-read from the global
 * registry on each turn so that tools registered after conversation creation
 * (e.g. via `vellum mcp reload`) are automatically picked up without
 * requiring conversation disposal or app restart.
 */
export function createResolveToolsCallback(
  toolDefs: ToolDefinition[],
  ctx: SkillProjectionContext,
): ((history: Message[]) => ToolDefinition[]) | undefined {
  if (toolDefs.length === 0) return undefined;

  // Separate the initial tool defs into core (stable) and MCP (dynamic).
  // We keep core tools from the snapshot and re-read MCP tools each turn.
  const initialMcpDefs = getMcpToolDefinitions();
  const initialMcpNames = new Set(initialMcpDefs.map((d) => d.name));
  const coreToolDefs = toolDefs.filter((d) => !initialMcpNames.has(d.name));
  log.debug(
    {
      coreCount: coreToolDefs.length,
      mcpCount: initialMcpDefs.length,
      mcpTools: initialMcpDefs.map((d) => d.name),
    },
    "Conversation tool resolver initialized",
  );

  return (history: Message[]) => {
    // When tools are explicitly disabled (e.g. during pointer generation),
    // return an empty tool list so the LLM never sees tool definitions and
    // keep the allowlist empty so no tool execution can slip through.
    if (ctx.toolsDisabledDepth > 0) {
      ctx.allowedToolNames = new Set<string>();
      return [];
    }

    // Filter core tools based on current conversation context so that tools
    // irrelevant to this turn (e.g. UI tools when no client is connected)
    // are omitted from the definitions sent to the provider.
    const filteredCoreDefs = coreToolDefs.filter((d) =>
      isToolActiveForContext(d.name, ctx),
    );

    // When the conversation is acting as a subagent, restrict core tools to
    // only those explicitly allowed by the parent orchestrator.
    const scopedCoreDefs = ctx.subagentAllowedTools
      ? filteredCoreDefs.filter((d) => ctx.subagentAllowedTools!.has(d.name))
      : filteredCoreDefs;

    // Re-read MCP tool definitions from the registry each turn so conversations
    // automatically pick up tools added/removed by `vellum mcp reload`.
    const currentMcpDefs = getMcpToolDefinitions();
    log.debug(
      {
        coreCount: scopedCoreDefs.length,
        mcpCount: currentMcpDefs.length,
        mcpTools: currentMcpDefs.map((d) => d.name),
      },
      "MCP tools resolved for turn",
    );
    const scopedMcpDefs = ctx.subagentAllowedTools
      ? currentMcpDefs.filter((d) => ctx.subagentAllowedTools!.has(d.name))
      : currentMcpDefs;
    const allBaseDefs = [...scopedCoreDefs, ...scopedMcpDefs];

    const effectivePreactivated = [
      ...DEFAULT_PREACTIVATED_SKILL_IDS,
      ...(ctx.preactivatedSkillIds ?? []),
    ];
    const projection = projectSkillTools(history, {
      preactivatedSkillIds: effectivePreactivated,
      previouslyActiveSkillIds: ctx.skillProjectionState,
      cache: ctx.skillProjectionCache,
    });
    const turnAllowed = new Set(allBaseDefs.map((d) => d.name));
    for (const name of projection.allowedToolNames) {
      // When a subagent allowlist is active, exclude skill tools not on it.
      if (ctx.subagentAllowedTools && !ctx.subagentAllowedTools.has(name)) {
        continue;
      }
      turnAllowed.add(name);
    }
    ctx.allowedToolNames = turnAllowed;
    return injectActivityField(allBaseDefs, ACTIVITY_SKIP_SET);
  };
}
