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
import { getIsPlatform } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import { getBindingByConversation } from "../persistence/external-conversation-store.js";
import { getAllDefaultPluginNames } from "../plugins/defaults/main.js";
import { isPluginDisabled } from "../plugins/disabled-state.js";
import type { Message, ToolDefinition } from "../providers/types.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { registerConversationSender } from "../tools/browser/browser-screencast.js";
import type { ToolExecutor } from "../tools/executor.js";
import {
  getMcpToolDefinitions,
  getPluginToolDefinitions,
  getTool,
  getToolOwner,
  getWorkspaceToolDefinitions,
  getWorkspaceToolNames,
  loadPluginTools,
} from "../tools/registry.js";
import {
  ACTIVITY_SKIP_SET,
  injectActivityField,
} from "../tools/schema-transforms.js";
import {
  augmentSkillExecuteError,
  recoverSkillExecuteEnvelope,
  resolveSkillExecuteInput,
} from "../tools/skills/execute.js";
import { resolveToolInvocationAlias } from "../tools/tool-name-aliases.js";
import type {
  ProxyApprovalCallback,
  ProxyApprovalRequest,
} from "../tools/tool-types.js";
import {
  isDiskPressureCleanupToolName,
  type ToolContext,
  type ToolExecutionResult,
} from "../tools/types.js";
import { loadWorkspaceTools } from "../tools/workspace-tools/loader.js";
import {
  resolveUsageAttribution,
  type UsageAttributionSnapshot,
} from "../usage/attribution.js";
import { getLogger } from "../util/logger.js";
import {
  projectSkillTools,
  type SkillProjectionCache,
} from "./conversation-skill-tools.js";
import { surfaceProxyResolver } from "./conversation-surfaces.js";
import {
  isDoordashCommand,
  markDoordashStepInProgress,
} from "./doordash-steps.js";
import type { ServerMessage, UiSurfaceShow } from "./message-protocol.js";
import { runPostExecutionSideEffects } from "./tool-side-effects.js";
import { FALLBACK_TURN_TRUST, resolveTrustClass } from "./trust-context.js";

const log = getLogger("conversation-tool-setup");

import type {
  SubagentToolGateMode,
  ToolSetupContext,
  WakeToolContextPin,
} from "./tool-setup-types.js";
export type {
  SubagentToolGateMode,
  ToolSetupContext,
  WakeToolContextPin,
} from "./tool-setup-types.js";

// ── resolveConversationAttribution ───────────────────────────────────

/**
 * Resolve the model attribution snapshot for the conversation at invocation
 * time (provider/model/profile that issued the current turn). Mirrors how
 * the agent-loop usage path builds its `UsageAttributionInput` — the
 * current turn's call site (`runAgentLoopImpl` sets `ctx.currentCallSite`
 * from `options.callSite`, defaulting to `mainAgent`) plus the
 * conversation's per-turn override profile — so `profileSource` resolves
 * to `call_site`/`conversation`/`active`/`default` exactly as `llm_usage`
 * records do for the same turn (non-main turns like voice `callAgent` or
 * `filingAgent` attribute their own call-site config, not the main
 * agent's). The conversation id is threaded as the mix selection seed so
 * mix-profile arms match what the dispatch path actually ran.
 *
 * Returns `null` on any failure: attribution must never break tool execution
 * (or skill loads, which reuse this helper). Consumers read it best-effort —
 * usage telemetry, and `subagent_spawn`, which inherits the resolved
 * `appliedProfile` so a child defaults to the invoking turn's profile.
 */
export function resolveConversationAttribution(
  ctx: Pick<
    ToolSetupContext,
    "conversationId" | "currentCallSite" | "currentTurnOverrideProfile"
  >,
): UsageAttributionSnapshot | null {
  try {
    return resolveUsageAttribution({
      callSite: ctx.currentCallSite ?? "mainAgent",
      overrideProfile: ctx.currentTurnOverrideProfile ?? null,
      selectionSeed: ctx.conversationId,
    });
  } catch (err) {
    log.debug(
      { err, conversationId: ctx.conversationId },
      "Failed to resolve conversation attribution for telemetry (non-fatal)",
    );
    return null;
  }
}

/**
 * Resolve a conversation's effective per-chat plugin scope as a Set for
 * membership checks. Returns `null` when there is no per-chat restriction
 * (`enabledPlugins` null/undefined) — meaning all globally-enabled plugins
 * apply — otherwise a Set of the scoped plugin ids. Later tool/skill/hook
 * filters intersect their candidate set against this; `null` is the no-op
 * sentinel (no intersection).
 *
 * Enablement precedence, highest first:
 *   1. Explicit per-conversation enable/disable — the `enabledPlugins`
 *      allowlist. A plugin listed here is enabled for this chat even if it is
 *      disabled at the workspace level; an installed plugin omitted from a
 *      non-null list is disabled for this chat.
 *   2. Explicit workspace enable/disable — the `.disabled` sentinel
 *      (`assistant plugins disable <name>`), via {@link isPluginDisabled}.
 *   3. Default plugins are enabled by default.
 *
 * The first-party default plugins are therefore unioned into a non-null scope
 * unless they are disabled at the workspace level: they are core runtime
 * infrastructure (memory, turn-context, workspace grounding, session framing,
 * history repair, title generation, …), not user-toggleable extensions, and
 * the per-chat pills only list user-INSTALLED plugins (`/v1/plugins`), so
 * without this union deselecting any pill would intersect the defaults out and
 * silently disable core behavior. A workspace-disabled default is left out so
 * `assistant plugins disable default-*` still takes effect; a default the
 * conversation explicitly enabled (rule 1) stays in regardless. Unioning here
 * fixes every consumer (tools/skills/hooks) at the single chokepoint.
 */
export function getEffectiveEnabledPluginSet(conv: {
  enabledPlugins?: string[] | null;
}): Set<string> | null {
  if (conv.enabledPlugins == null) {
    return null;
  }
  // Rule 1: the conversation's explicit selections always apply.
  const effective = new Set(conv.enabledPlugins);
  // Rules 2 + 3: add a default the conversation did not already decide, unless
  // it is disabled at the workspace level.
  for (const name of getAllDefaultPluginNames()) {
    if (!effective.has(name) && !isPluginDisabled(name)) {
      effective.add(name);
    }
  }
  return effective;
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

  // Execution-layer allowlist gate (`subagentToolGateMode === "execution"`,
  // see {@link SubagentToolGateMode}): rejects non-allowlisted calls BEFORE
  // any executor dispatch, so a non-allowlisted tool's executor never runs.
  // The error tool_result lets the model continue or finish.
  const rejectNonAllowlistedTool = (
    toolName: string,
  ): ToolExecutionResult | null => {
    if (ctx.subagentToolGateMode !== "execution") {
      return null;
    }
    const allowlist = ctx.subagentAllowedTools;
    if (!allowlist || allowlist.has(toolName)) {
      return null;
    }
    const allowed = [...allowlist].sort().join(", ");
    return {
      content: `This background pass may only use: ${allowed}.`,
      isError: true,
    };
  };

  // Per-chat plugin scope guard for the `skill_execute` dispatch path. The
  // wire definitions + per-turn `allowedToolNames` already keep an excluded
  // plugin's tools off the model's tool surface, but `skill_execute` names its
  // inner tool by string, so resolve the inner tool's owner and reject when it
  // belongs to a plugin outside the conversation's effective set. Authoritative
  // regardless of how the name was obtained (also covers name collisions where
  // the projected name is owned by a different, in-scope source). `null` =
  // no per-chat restriction; non-plugin tools are never blocked.
  const rejectOutOfScopePluginTool = (
    toolName: string,
    effectiveSet: Set<string> | null,
  ): ToolExecutionResult | null => {
    if (effectiveSet === null) {
      return null;
    }
    const owner = getToolOwner(toolName);
    if (owner?.kind !== "plugin" || effectiveSet.has(owner.id)) {
      return null;
    }
    return {
      content: `Tool "${toolName}" belongs to a plugin that is not enabled in this conversation.`,
      isError: true,
    };
  };

  return async (
    name: string,
    input: Record<string, unknown>,
    onOutput?: (chunk: string) => void,
    toolUseId?: string,
  ) => {
    const { name: executionName, input: executionInput } =
      resolveToolInvocationAlias(name, input, ctx.allowedToolNames);

    // Resolve the conversation's effective per-chat plugin scope once per tool
    // call: reused for the ToolContext field (read by skill-surface tools) and
    // the skill_execute dispatch guard below.
    const effectiveEnabledPluginSet = getEffectiveEnabledPluginSet(ctx);

    // The execution-layer gate must run FIRST — before any interception or
    // pre-execution side effect (DoorDash step marking) — so a non-allowlisted
    // tool can neither run nor mutate conversation state. `skill_execute` is
    // dispatch indirection: it is gated on its resolved inner tool name inside
    // the interception below, mirroring how wire mode gates the underlying
    // tool, not the wrapper.
    if (executionName !== "skill_execute") {
      const rejection = rejectNonAllowlistedTool(executionName);
      if (rejection) {
        return rejection;
      }
    }

    if (isDoordashCommand(executionName, executionInput)) {
      markDoordashStepInProgress(ctx, executionInput);
    }

    // Per-turn trust snapshot: prefer the snapshot captured at turn start so
    // a concurrent owner meta command (/status, /clean) that mutates the live
    // trustContext cannot elevate the in-flight turn to guardian.
    const turnTrust =
      ctx.currentTurnTrustContext ?? ctx.trustContext ?? FALLBACK_TURN_TRUST;

    const toolContext: ToolContext = {
      workingDir: ctx.workingDir,
      conversationId: ctx.conversationId,
      assistantId: ctx.assistantId,
      requestId: ctx.currentRequestId,
      taskRunId: ctx.taskRunId,
      trustClass: resolveTrustClass(turnTrust),
      executionChannel: turnTrust.sourceChannel,
      requestOrigin: ctx.currentTurnRequestOrigin,
      sourceActorPrincipalId: turnTrust.guardianPrincipalId,
      callSessionId: ctx.callSessionId,
      triggeredBySurfaceAction:
        ctx.surfaceActionRequestIds?.has(ctx.currentRequestId ?? "") ?? false,
      approvedViaPrompt: ctx.approvedViaPromptThisTurn || undefined,
      batchAuthorizedByTask: false,
      requesterExternalUserId: turnTrust.requesterExternalUserId,
      requesterChatId: turnTrust.requesterChatId,
      requesterIdentifier: turnTrust.requesterIdentifier,
      requesterDisplayName: turnTrust.requesterDisplayName,
      channelConversationType: turnTrust.conversationType,
      // The binding's external chat id is the canonical conversation address
      // for every channel adapter (Slack channel, Telegram chat, …); it keys
      // the channel tier of permission-matrix cell resolution, so a
      // channel-scoped cell governs regardless of adapter. Internal turns
      // ("vellum" — the fallback and control-plane channel — or no source
      // channel at all) never have a binding, so they skip the lookup.
      channelPermissionChannelId:
        turnTrust.sourceChannel && turnTrust.sourceChannel !== "vellum"
          ? getBindingByConversation(ctx.conversationId)?.externalChatId
          : undefined,
      onOutput,
      signal: ctx.abortController?.signal,
      allowedToolNames: ctx.allowedToolNames,
      subagentAllowedTools: ctx.subagentAllowedTools,
      forcePromptSideEffects: ctx.forcePromptSideEffects,
      diskPressureCleanupModeActive: ctx.diskPressureCleanupModeActive,
      toolUseId,
      isPlatformHosted: getIsPlatform(),
      transportInterface: ctx.transportInterface,
      overrideProfile: ctx.currentTurnOverrideProfile,
      invokingCallSite: ctx.currentCallSite ?? "mainAgent",
      attribution: resolveConversationAttribution(ctx),
      enabledPluginSet: effectiveEnabledPluginSet,
      sendToClient: (msg) => {
        // Tool context's sendToClient uses a loose { type: string; [key: string]: unknown }
        // signature, but at runtime these are always ServerMessage instances.
        ctx.sendToClient(msg as ServerMessage);
        if (msg.type === "ui_surface_show") {
          const s = msg as unknown as UiSurfaceShow;
          const surfaceToolCallId = s.toolCallId ?? toolUseId;
          ctx.currentTurnSurfaces.push({
            surfaceId: s.surfaceId,
            surfaceType: s.surfaceType,
            title: s.title,
            data: s.data,
            actions: s.actions,
            display: s.display,
            ...(s.persistent ? { persistent: true } : {}),
            ...(surfaceToolCallId ? { toolCallId: surfaceToolCallId } : {}),
          });
        }
      },
      isInteractive:
        ctx.currentTurnIsNonInteractive !== undefined
          ? !ctx.currentTurnIsNonInteractive
          : !ctx.hasNoClient && !ctx.headlessLock,
      proxyToolResolver: (
        toolName: string,
        proxyInput: Record<string, unknown>,
      ) =>
        surfaceProxyResolver(
          ctx,
          toolName,
          proxyInput,
          ctx.abortController?.signal,
          toolUseId,
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
    if (executionName === "skill_execute") {
      // Recover an envelope the provider wrapped as unparseable when MiniMax's
      // coercion failed to JSON-decode a bare-string `input` (see
      // recoverSkillExecuteEnvelope), then resolve the inner tool + params.
      const envelope = recoverSkillExecuteEnvelope(executionInput);
      const rawToolName =
        typeof envelope.tool === "string" ? envelope.tool : "";
      const innerSchema = rawToolName
        ? getTool(rawToolName)?.input_schema
        : undefined;
      const rawToolInput = resolveSkillExecuteInput(envelope, innerSchema);

      // Clone to avoid mutating shared input objects
      const { name: toolName, input: toolInput } = resolveToolInvocationAlias(
        rawToolName,
        { ...rawToolInput },
        ctx.allowedToolNames,
      );

      if (!toolName) {
        return {
          content:
            'Error: skill_execute requires a "tool" parameter with the tool name',
          isError: true,
        };
      }

      // Gate the resolved inner tool, not the skill_execute wrapper — the
      // wrapper is dispatch indirection, mirroring how wire mode gates the
      // underlying tool via the executor's allowedToolNames check.
      const innerRejection = rejectNonAllowlistedTool(toolName);
      if (innerRejection) {
        return innerRejection;
      }

      // Per-chat plugin scope: reject the resolved inner tool when it belongs
      // to a plugin outside the conversation's effective set.
      const pluginRejection = rejectOutOfScopePluginTool(
        toolName,
        effectiveEnabledPluginSet,
      );
      if (pluginRejection) {
        return pluginRejection;
      }

      const rawResult = await executor.execute(
        toolName,
        toolInput,
        toolContext,
      );
      const result = augmentSkillExecuteError(toolName, toolInput, rawResult);
      if (toolContext.approvedViaPrompt) {
        ctx.approvedViaPromptThisTurn = true;
      }

      void runPostExecutionSideEffects(toolName, toolInput, result, { ctx });

      return result;
    }

    const result = await executor.execute(
      executionName,
      executionInput,
      toolContext,
    );
    if (toolContext.approvedViaPrompt) {
      ctx.approvedViaPromptThisTurn = true;
    }

    void runPostExecutionSideEffects(executionName, executionInput, result, {
      ctx,
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
  _prompter: PermissionPrompter,
  _ctx: ToolSetupContext,
): ProxyApprovalCallback {
  return async (_request: ProxyApprovalRequest): Promise<boolean> => {
    // Proxied asks follow the same non-host auto-allow contract as regular
    // network_request invocations — suppress deterministic approval cards.
    return true;
  };
}

// ── createResolveToolsCallback ───────────────────────────────────────

/**
 * Bundled skills that must always be active regardless of conversation
 * history or explicit preactivation. Without this, their tools are
 * unavailable in fresh conversations until `skill_load` is called.
 */
export const DEFAULT_PREACTIVATED_SKILL_IDS = ["notifications", "subagent"];

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
  /**
   * Durable copy of the full tool set resolved on the most recent turn, used
   * by read-only inventory queries. Set alongside {@link allowedToolNames}
   * but, unlike that per-turn execution gate, never cleared at turn teardown.
   */
  lastResolvedToolNames?: Set<string>;
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
  /**
   * How {@link subagentAllowedTools} is enforced — see
   * {@link SubagentToolGateMode}. Absent means `"wire"`.
   */
  subagentToolGateMode?: SubagentToolGateMode;
  /**
   * When set (execution-gate-mode wakes), tool-definition resolution reads
   * `hasNoClient` / `transportInterface` / `channelCapabilities` exclusively
   * from this pin instead of the live conversation — see
   * {@link WakeToolContextPin}.
   */
  readonly toolContextPin?: WakeToolContextPin;
  /** True when the current turn is restricted to disk-pressure cleanup-safe tools. */
  diskPressureCleanupModeActive?: boolean;
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
  /** Per-turn override profile. */
  currentTurnOverrideProfile?: string;
  /**
   * The conversation's per-chat plugin scope (mirrors
   * {@link Conversation.enabledPlugins}). `null`/absent means no per-chat
   * restriction; otherwise plugin-owned tools and skills are intersected with
   * the effective set (the scope unioned with the always-on first-party
   * defaults) via {@link getEffectiveEnabledPluginSet}. Read per turn so a
   * mid-conversation scope change is picked up.
   */
  readonly enabledPlugins?: string[] | null;
  /**
   * Conversation id for `skill_loaded` telemetry. Absent (e.g. minimal test
   * contexts) disables telemetry recording in the skill projection.
   */
  readonly conversationId?: string;
  /**
   * The LLM call site driving the current turn (see
   * {@link ToolSetupContext.currentCallSite}) — read per turn so skill_loaded
   * telemetry attributes the provider/model/profile the turn actually ran on.
   */
  currentCallSite?: LLMCallSite;
}

// ── Conditional tool sets ────────────────────────────────────────────

const UI_SURFACE_TOOL_NAMES = new Set(["ui_show", "ui_update", "ui_dismiss"]);
const SLACK_TASK_PROGRESS_UI_TOOL_NAMES = new Set(["ui_show", "ui_update"]);
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
  ["host_file_transfer", "host_file"],
  ["host_browser", "host_browser"],
]);
// Derived from HOST_TOOL_TO_CAPABILITY so the invariant "every host tool has
// a capability mapping" is a structural fact — no runtime assertion needed.
export const HOST_TOOL_NAMES = new Set(HOST_TOOL_TO_CAPABILITY.keys());
/**
 * Capabilities eligible for cross-client exposure on non-host-proxy
 * transports (e.g. web, ios routing to a connected capable client).
 * Adding a capability here exposes ALL tools that map to it (per
 * HOST_TOOL_TO_CAPABILITY) on non-host-proxy transports — the daemon then
 * routes the actual invocation to the connected capable client via the
 * proxy's targetClientId path.
 *
 * All members below adopt the same-actor enforcement pattern: the proxy
 * binds the request to a specific client id + actor principal id at
 * dispatch time, and the corresponding result route requires the
 * submitting client to present an `x-vellum-client-id` matching the
 * captured target plus an `x-vellum-actor-principal-id` matching the
 * captured actor (see `enforceSameActorOrThrow` in
 * `runtime/auth/same-actor.ts`).
 *
 * Inclusions:
 * - host_bash (Phase 1, PR #29322)
 * - host_file (Phases 2 & 3, PRs #29398 + #29440)
 * - host_browser (PR #27489 executor parity + PR #29829 cross-client
 *   exposure with same-actor guard at proxy dispatch and result route)
 *
 * Exclusions:
 * - host_app_control, host_cu: not in HOST_TOOL_TO_CAPABILITY (skill-routed).
 *   Their cross-client exposure is handled at the skill preactivation layer
 *   via `preactivateHostProxySkills` — see host-proxy-preactivation.ts.
 */
const CROSS_CLIENT_EXPOSED_CAPABILITIES = new Set<HostProxyCapability>([
  "host_bash",
  "host_file",
  "host_browser",
]);
// Tools that require a connected client but no specific host proxy capability.
const CLIENT_CAPABILITY_TOOL_NAMES = new Set(["app_open", "ask_question"]);
const PLATFORM_TOOL_NAMES = new Set(["request_system_permission"]);

/**
 * Tools that should only be visible to subagent conversations. Main (parent)
 * conversations never see these in the LLM tool definitions. Subsequent PRs
 * will populate this set; it starts empty so there is no behavioral change.
 */
export const SUBAGENT_ONLY_TOOL_NAMES = new Set<string>([
  "file_list",
  "code_search",
  "notify_parent",
]);

/**
 * Determine whether a tool is part of the final exposed tool set for the
 * current turn. This helper mirrors the filtering applied by
 * `createResolveToolsCallback` — including the subagent allowlist,
 * `toolsDisabledDepth`, and disk-pressure cleanup restrictions.
 */
export function isToolActiveForContext(
  name: string,
  ctx: SkillProjectionContext,
): boolean {
  // Execution-gate-mode wakes pin the client-context inputs so the wire tool
  // surface matches the SOURCE conversation's live turns rather than the
  // fork's clientless hydration (see {@link WakeToolContextPin}). When the
  // pin is present it replaces all three values — channel capabilities pin
  // to `undefined` (see the pin's doc for why unset IS parity), never
  // falling through to live state.
  const pin = ctx.toolContextPin;
  const hasNoClient = pin ? pin.hasNoClient : ctx.hasNoClient;
  const channelCapabilities = pin ? undefined : ctx.channelCapabilities;
  const transportInterface = pin
    ? pin.transportInterface
    : ctx.transportInterface;

  // When the conversation is acting as a subagent, the parent orchestrator
  // restricts the tool list. A tool that isn't on the allowlist is not
  // available for this turn, so short-circuit before any capability checks.
  // In execution gate mode the allowlist is enforced at execution time
  // instead — the full tool surface stays visible on the wire.
  if (
    ctx.subagentAllowedTools &&
    ctx.subagentToolGateMode !== "execution" &&
    !ctx.subagentAllowedTools.has(name)
  ) {
    return false;
  }
  // `createResolveToolsCallback` returns an empty tool list when tools are
  // disabled (e.g. pointer-generation turns) and restricts to cleanup-safe
  // tools under disk pressure. Mirror both here so this helper reports the
  // same final tool set the LLM receives.
  if (ctx.toolsDisabledDepth > 0) {
    return false;
  }
  if (
    ctx.diskPressureCleanupModeActive === true &&
    !isDiskPressureCleanupToolName(name)
  ) {
    return false;
  }
  if (name === "remember") {
    try {
      return getConfig().memory?.enabled !== false;
    } catch {
      return true;
    }
  }
  if (UI_SURFACE_TOOL_NAMES.has(name)) {
    if (
      channelCapabilities?.channel === "slack" &&
      SLACK_TASK_PROGRESS_UI_TOOL_NAMES.has(name)
    ) {
      return !hasNoClient;
    }
    return channelCapabilities?.supportsDynamicUi ?? !hasNoClient;
  }
  if (HOST_TOOL_NAMES.has(name)) {
    const capability = HOST_TOOL_TO_CAPABILITY.get(name);
    const transport = transportInterface;

    // Per-capability check is authoritative for structural support: if the
    // transport cannot service this capability, the tool is filtered out.
    if (transport && capability && !supportsHostProxy(transport, capability)) {
      // Cross-client exception: allow host tools whose capabilities have
      // cross-client routing infrastructure (Phases 1–3 plus host_browser
      // via PR #27489) to be exposed for non-host-proxy transports (e.g.
      // "web", "ios") when at least one capable client is connected via
      // the event hub. Members of CROSS_CLIENT_EXPOSED_CAPABILITIES
      // (host_bash, host_file, host_browser) qualify.
      // chrome-extension transport is excluded as a security boundary
      // (extension only gets host_browser via its own executor path);
      // hasNoClient turns are excluded (no interactive approval UI
      // available).
      if (
        capability &&
        CROSS_CLIENT_EXPOSED_CAPABILITIES.has(capability) &&
        transport !== "chrome-extension" &&
        !hasNoClient &&
        assistantEventHub.listClientsByCapability(capability).length > 0
      ) {
        return true;
      }
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
    return !hasNoClient;
  }
  if (CLIENT_CAPABILITY_TOOL_NAMES.has(name)) {
    if (name === "ask_question" && channelCapabilities?.clientOS === "macos") {
      // macOS has no UI handler for question_request yet; hiding the tool
      // avoids a 5-minute prompter timeout when the LLM would otherwise call it.
      return false;
    }
    return !hasNoClient;
  }
  if (PLATFORM_TOOL_NAMES.has(name)) {
    // Check the *client's* platform, not the daemon's process.platform.
    // In Docker the daemon runs on Linux but the connected client may be macOS.
    return channelCapabilities?.clientOS === "macos" && !hasNoClient;
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
 * Core (non-MCP, non-workspace) tool definitions are captured at conversation
 * creation and reused on each turn. MCP and workspace tool definitions are
 * re-read from the global registry on each turn so that tools registered or
 * changed after conversation creation are automatically picked up without
 * requiring conversation disposal or app restart — MCP via `vellum mcp
 * reload`, workspace tools via edits under `<workspaceDir>/tools/` that the
 * per-turn reconcile (kicked below) folds into the registry.
 */
export function createResolveToolsCallback(
  toolDefs: ToolDefinition[],
  ctx: SkillProjectionContext,
): ((history: Message[]) => ToolDefinition[]) | undefined {
  if (toolDefs.length === 0) {
    return undefined;
  }

  // Separate the initial tool defs into core (stable) and the dynamic
  // categories (MCP, workspace, plugin). We keep core tools from the snapshot
  // and re-read the dynamic categories from the registry each turn. They differ
  // downstream: plugin tools flow through the same context filter + subagent
  // allowlist as core, while MCP and workspace tools are added raw.
  const initialMcpDefs = getMcpToolDefinitions();
  const initialPluginDefs = getPluginToolDefinitions();
  const initialMcpNames = new Set(initialMcpDefs.map((d) => d.name));
  const initialWorkspaceNames = new Set(getWorkspaceToolNames());
  const initialPluginNames = new Set(initialPluginDefs.map((d) => d.name));
  const coreToolDefs = toolDefs.filter(
    (d) =>
      !initialMcpNames.has(d.name) &&
      !initialWorkspaceNames.has(d.name) &&
      !initialPluginNames.has(d.name),
  );
  log.debug(
    {
      coreCount: coreToolDefs.length,
      mcpCount: initialMcpDefs.length,
      mcpTools: initialMcpDefs.map((d) => d.name),
      workspaceCount: initialWorkspaceNames.size,
      pluginCount: initialPluginDefs.length,
      pluginTools: initialPluginDefs.map((d) => d.name),
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

    // Resolve the conversation's effective per-chat plugin scope ONCE for this
    // turn and reuse it for the plugin-tool filter and the skill projection.
    // `null` = no per-chat restriction; otherwise a fresh Set of the selection
    // unioned with the always-on first-party defaults.
    const effectiveEnabledPluginSet = getEffectiveEnabledPluginSet(ctx);

    // Reconcile workspace tool overrides under `<workspaceDir>/tools/` into
    // the registry, then re-read them below — the on-read replacement for a
    // filesystem watcher. Fire-and-forget: the reconcile is idempotent,
    // mtime-cached (a no-op costs one readdir + a stat per file) and
    // serialized, so the registry settles for a subsequent turn to read.
    void loadWorkspaceTools();

    // Same treatment for user-plugin tools: pull the plugin mtime-cache's
    // active tool set into the registry (a no-op costs one sentinel stat +
    // fingerprint compares), so a plugin installed/removed/edited at runtime
    // is picked up without recreating the conversation.
    void loadPluginTools();

    // Re-read plugin tool definitions from the registry each turn. Plugin
    // tools share core's context filter + allowlist path, so combine them
    // with the core snapshot before filtering.
    const currentPluginDefs = getPluginToolDefinitions();

    // Scope plugin tools to the conversation's per-chat plugin set. `null`
    // leaves the list unchanged (no per-chat restriction); otherwise keep only
    // tools whose owning plugin id is in the set, mirroring the
    // `subagentAllowedTools` intersection below. Ownership lives in the registry
    // (queried via getToolOwner), not on the Tool object.
    const scopedPluginDefs =
      effectiveEnabledPluginSet === null
        ? currentPluginDefs
        : currentPluginDefs.filter((d) => {
            const ownerId = getToolOwner(d.name)?.id;
            return (
              ownerId !== undefined && effectiveEnabledPluginSet.has(ownerId)
            );
          });

    // Filter core + plugin tools based on current conversation context so that
    // tools irrelevant to this turn (e.g. UI tools when no client is connected)
    // are omitted from the definitions sent to the provider.
    const filteredCoreDefs = [...coreToolDefs, ...scopedPluginDefs].filter(
      (d) => isToolActiveForContext(d.name, ctx),
    );

    // When the conversation is acting as a subagent, restrict core tools to
    // only those explicitly allowed by the parent orchestrator. In
    // `"execution"` gate mode the allowlist is NOT applied to the wire
    // definitions (see {@link SubagentToolGateMode}) — the executor callback
    // rejects non-allowlisted calls at execution time instead.
    const wireAllowlist =
      ctx.subagentToolGateMode === "execution"
        ? undefined
        : ctx.subagentAllowedTools;
    const scopedCoreDefs = wireAllowlist
      ? filteredCoreDefs.filter((d) => wireAllowlist.has(d.name))
      : filteredCoreDefs;

    // Re-read MCP and workspace tool definitions from the registry each turn
    // so conversations automatically pick up tools added/removed by `vellum
    // mcp reload` and workspace-tool edits reconciled from disk, without
    // recreating the conversation.
    const currentMcpDefs = getMcpToolDefinitions();
    const currentWorkspaceDefs = getWorkspaceToolDefinitions();
    log.debug(
      {
        coreCount: scopedCoreDefs.length,
        mcpCount: currentMcpDefs.length,
        mcpTools: currentMcpDefs.map((d) => d.name),
        workspaceCount: currentWorkspaceDefs.length,
        workspaceTools: currentWorkspaceDefs.map((d) => d.name),
      },
      "MCP and workspace tools resolved for turn",
    );
    const scopedMcpDefs = wireAllowlist
      ? currentMcpDefs.filter((d) => wireAllowlist.has(d.name))
      : currentMcpDefs;
    const scopedWorkspaceDefs = wireAllowlist
      ? currentWorkspaceDefs.filter((d) => wireAllowlist.has(d.name))
      : currentWorkspaceDefs;
    const excluded = new Set(getConfig().tools.exclude);
    const allBaseDefs = [
      ...scopedCoreDefs,
      ...scopedWorkspaceDefs,
      ...scopedMcpDefs,
    ].filter((d) => !excluded.has(d.name));

    const effectivePreactivated = [
      ...DEFAULT_PREACTIVATED_SKILL_IDS,
      ...(ctx.preactivatedSkillIds ?? []),
    ];
    const projection = projectSkillTools(history, {
      preactivatedSkillIds: effectivePreactivated,
      previouslyActiveSkillIds: ctx.skillProjectionState,
      cache: ctx.skillProjectionCache,
      // Scope plugin-contributed skills to the conversation's per-chat plugin
      // selection (null = no restriction).
      effectiveEnabledPluginSet,
      // skill_loaded telemetry context — resolved per turn so attribution
      // reflects the call site/profile the current turn actually runs on.
      telemetry:
        ctx.conversationId !== undefined
          ? {
              conversationId: ctx.conversationId,
              attribution: resolveConversationAttribution({
                conversationId: ctx.conversationId,
                currentCallSite: ctx.currentCallSite,
                currentTurnOverrideProfile: ctx.currentTurnOverrideProfile,
              }),
            }
          : undefined,
    });
    const turnAllowed = new Set(allBaseDefs.map((d) => d.name));
    for (const name of projection.allowedToolNames) {
      // When a wire-gated subagent allowlist is active, exclude skill tools
      // not on it. (Execution gate mode keeps them available here and
      // rejects non-allowlisted calls in the executor callback instead.)
      if (wireAllowlist && !wireAllowlist.has(name)) {
        continue;
      }
      if (excluded.has(name)) {
        continue;
      }
      turnAllowed.add(name);
    }
    // Record the full resolved inventory durably for read-only queries before
    // any degraded-mode narrowing below — `allowedToolNames` is the per-turn
    // execution gate (cleared at teardown and restricted under disk pressure),
    // whereas this snapshot answers "what tools does this conversation have".
    ctx.lastResolvedToolNames = turnAllowed;
    if (ctx.diskPressureCleanupModeActive === true) {
      const cleanupDefs = allBaseDefs.filter((d) =>
        isDiskPressureCleanupToolName(d.name),
      );
      ctx.allowedToolNames = new Set(
        Array.from(turnAllowed).filter(isDiskPressureCleanupToolName),
      );
      return injectActivityField(cleanupDefs, ACTIVITY_SKIP_SET);
    }

    ctx.allowedToolNames = turnAllowed;
    const baseDefs = injectActivityField(allBaseDefs, ACTIVITY_SKIP_SET);

    return baseDefs;
  };
}
