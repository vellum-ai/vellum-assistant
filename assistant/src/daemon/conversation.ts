/**
 * Conversation — thin coordinator that delegates to extracted modules.
 *
 * Each concern lives in its own file:
 * - conversation-lifecycle.ts    — loadFromDb, abort, dispose
 * - conversation-messaging.ts    — enqueueMessage, persistUserMessage, redirectToSecurePrompt
 * - conversation-agent-loop.ts   — runAgentLoop, generateTitle
 * - conversation-notifiers.ts    — watch/call notifier registration
 * - conversation-tool-setup.ts   — tool definitions, executor, resolveTools callback
 * - conversation-media-retry.ts  — media trimming + raceWithTimeout
 * - conversation-process.ts      — drainQueue, processMessage
 * - conversation-history.ts      — undo, regenerate, consolidateAssistantMessages
 * - conversation-surfaces.ts     — handleSurfaceAction, handleSurfaceUndo
 * - conversation-workspace.ts    — refreshWorkspaceTopLevelContext
 * - conversation-usage.ts        — recordUsage
 */

import type { ResolvedSystemPrompt } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type {
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { Speed } from "../config/schemas/inference.js";
import {
  ContextWindowManager,
  type ContextWindowResult,
  getSummaryFromContextMessage,
} from "../context/window-manager.js";
import type { CesClient } from "../credential-execution/client.js";
import { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import { createToolAuditListener } from "../events/tool-audit-listener.js";
import { createToolDomainEventPublisher } from "../events/tool-domain-event-publisher.js";
import { registerToolMetricsLoggingListener } from "../events/tool-metrics-listener.js";
import { registerToolNotificationListener } from "../events/tool-notification-listener.js";
import { registerToolPermissionTelemetryListener } from "../events/tool-permission-telemetry-listener.js";
import {
  registerToolProfilingListener,
  ToolProfiler,
} from "../events/tool-profiling-listener.js";
import { registerToolTraceListener } from "../events/tool-trace-listener.js";
import { getHookManager } from "../hooks/manager.js";
import { enqueueAutoAnalysisOnCompaction } from "../memory/auto-analysis-enqueue.js";
import { resolveCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import {
  updateConversationContextWindow,
  updateConversationHostAccess,
} from "../memory/conversation-crud.js";
import { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { SecretPrompter } from "../permissions/secret-prompter.js";
import { patternMatchesCandidate } from "../permissions/trust-store.js";
import type { UserDecision } from "../permissions/types.js";
import {
  isConversationHostAccessDecision,
  isConversationHostAccessEnabled,
  isConversationHostAccessEnablePrompt,
} from "../permissions/v2-consent-policy.js";
import { resolvePersonaContext } from "../prompts/persona-resolver.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import type { Message, ModelIntent } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import type { AuthContext } from "../runtime/auth/types.js";
import * as approvalOverrides from "../runtime/conversation-approval-overrides.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { ToolExecutor } from "../tools/executor.js";
import type { OnboardingContext } from "../types/onboarding-context.js";
import type { AbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import type { AssistantAttachmentDraft } from "./assistant-attachments.js";
import { runAgentLoopImpl } from "./conversation-agent-loop.js";
import type { HistoryConversationContext } from "./conversation-history.js";
import {
  regenerate as regenerateImpl,
  undo as undoImpl,
} from "./conversation-history.js";
import {
  abortConversation,
  disposeConversation,
  loadFromDb as loadFromDbImpl,
} from "./conversation-lifecycle.js";
import type { RedirectToSecurePromptOptions } from "./conversation-messaging.js";
import {
  enqueueMessage as enqueueMessageImpl,
  persistUserMessage as persistUserMessageImpl,
  redirectToSecurePrompt as redirectToSecurePromptImpl,
} from "./conversation-messaging.js";
// Extracted modules
import { registerConversationNotifiers } from "./conversation-notifiers.js";
import type { ProcessConversationContext } from "./conversation-process.js";
import {
  drainQueue as drainQueueImpl,
  processMessage as processMessageImpl,
} from "./conversation-process.js";
import type { QueueDrainReason } from "./conversation-queue-manager.js";
import { MessageQueue } from "./conversation-queue-manager.js";
import type {
  ChannelCapabilities,
  TrustContext,
} from "./conversation-runtime-assembly.js";
import type { SkillProjectionCache } from "./conversation-skill-tools.js";
import {
  createSurfaceMutex,
  handleSurfaceAction as handleSurfaceActionImpl,
  handleSurfaceUndo as handleSurfaceUndoImpl,
  type SurfaceActionResult,
} from "./conversation-surfaces.js";
import type { ToolSetupContext } from "./conversation-tool-setup.js";
import {
  buildToolDefinitions,
  createResolveToolsCallback,
  createToolExecutor,
} from "./conversation-tool-setup.js";
import { refreshWorkspaceTopLevelContextIfNeeded as refreshWorkspaceImpl } from "./conversation-workspace.js";
import { HostBashProxy } from "./host-bash-proxy.js";
import { HostBrowserProxy } from "./host-browser-proxy.js";
import type { CuObservationResult } from "./host-cu-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
import { HostFileProxy } from "./host-file-proxy.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UsageStats,
  UserMessageAttachment,
} from "./message-protocol.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";
import { isHostProxyTransport } from "./message-types/conversations.js";
import type {
  AssistantActivityState,
  ConfirmationStateChanged,
} from "./message-types/messages.js";
import { TraceEmitter } from "./trace-emitter.js";

const log = getLogger("conversation");

export interface ConversationMemoryPolicy {
  scopeId: string;
  includeDefaultFallback: boolean;
  strictSideEffects: boolean;
}

export const DEFAULT_MEMORY_POLICY: Readonly<ConversationMemoryPolicy> =
  Object.freeze({
    scopeId: "default",
    includeDefaultFallback: false,
    strictSideEffects: false,
  });

export { findLastUndoableUserMessageIndex } from "./conversation-history.js";
export type {
  QueueDrainReason,
  QueuePolicy,
} from "./conversation-queue-manager.js";

export class Conversation {
  public readonly conversationId: string;
  /** @internal */ provider: Provider;
  /** @internal */ messages: Message[] = [];
  /** @internal */ agentLoop: AgentLoop;
  /** @internal */ processing = false;
  private stale = false;
  /** @internal */ abortController: AbortController | null = null;
  /** @internal */ prompter: PermissionPrompter;
  /** @internal */ secretPrompter: SecretPrompter;
  private executor: ToolExecutor;
  /** @internal */ profiler: ToolProfiler;
  /** @internal */ sendToClient: (msg: ServerMessage) => void;
  /** @internal */ eventBus = new EventBus<AssistantDomainEvents>();
  /** @internal */ workingDir: string;
  /** @internal */ allowedToolNames?: Set<string>;
  /** @internal */ toolsDisabledDepth = 0;
  /** @internal */ preactivatedSkillIds?: string[];
  /** @internal */ subagentAllowedTools?: Set<string>;
  /** @internal */ coreToolNames: Set<string>;
  /** @internal */ readonly skillProjectionState = new Map<string, string>();
  /** @internal */ readonly skillProjectionCache: SkillProjectionCache = {};
  /** @internal */ usageStats: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  };
  /** @internal */ readonly systemPrompt: string;
  /** @internal */ contextWindowManager: ContextWindowManager;
  /** @internal */ contextCompactedMessageCount = 0;
  /** @internal */ contextCompactedAt: number | null = null;
  /**
   * Tracks consecutive compaction failures (summary LLM call threw). In-memory
   * only — resets to 0 on process restart, which is the intended "one free
   * retry after restart" behavior. Reset to 0 on any successful compaction.
   */
  /** @internal */ consecutiveCompactionFailures = 0;
  /**
   * When the circuit breaker is open, this timestamp (ms since epoch) marks
   * when auto-compaction is allowed to resume. Set to `Date.now() + 1h` after
   * 3 consecutive failures; cleared on a successful compaction. User-initiated
   * compaction (`force: true`) bypasses the breaker regardless.
   */
  /** @internal */ compactionCircuitOpenUntil: number | null = null;
  /** @internal */ currentRequestId?: string;
  /** @internal */ hasNoClient = false;
  /** @internal */ isSubagent = false;
  /** @internal */ headlessLock = false;
  /** @internal */ taskRunId?: string;
  /** @internal */ callSessionId?: string;
  /** @internal */ hostBashProxy?: HostBashProxy;
  /** @internal */ hostBrowserProxy?: HostBrowserProxy;
  /** @internal */ hostCuProxy?: HostCuProxy;
  /** @internal */ hostFileProxy?: HostFileProxy;
  /**
   * Optional override sender used by `restoreBrowserProxyAvailability` so
   * registry-routed transports can preserve their sender across drain queue
   * restores. When set, `restoreBrowserProxyAvailability()` uses this
   * function instead of `sendToClient` so the drain-queue path doesn't
   * clobber the registry-routed sender with the SSE hub emitter.
   *
   * Populated by the POST /messages handler when the guardian has an active
   * extension connection in the `ChromeExtensionRegistry`, regardless of
   * interface (chrome-extension, macOS, etc.). Cleared when a turn without
   * an active extension connection takes over.
   */
  /** @internal */ hostBrowserSenderOverride?: (msg: ServerMessage) => void;
  /** @internal */ cesClient?: CesClient;
  /** @internal */ readonly queue = new MessageQueue();
  /** @internal */ currentActiveSurfaceId?: string;
  /** @internal */ currentPage?: string;
  /** @internal */ channelCapabilities?: ChannelCapabilities;
  /** @internal */ trustContext?: TrustContext;
  /**
   * Per-turn snapshots of persona-relevant context, captured at the start of
   * each message processing turn. The system prompt callback reads these
   * instead of the live fields so that a concurrent request cannot swap
   * another actor's persona mid-turn.
   */
  /** @internal */ currentTurnTrustContext?: TrustContext;
  /** @internal */ currentTurnChannelCapabilities?: ChannelCapabilities;
  /** @internal */ authContext?: AuthContext;
  /** @internal */ loadedHistoryTrustClass?: TrustClass;
  /** @internal */ voiceCallControlPrompt?: string;
  /** @internal */ transportHints?: string[];
  /** @internal */ assistantId?: string;
  /** @internal */ commandIntent?: {
    type: string;
    payload?: string;
    languageCode?: string;
  };
  /** @internal */ surfaceActionRequestIds = new Set<string>();
  /** @internal */ pendingSurfaceActions = new Map<
    string,
    { surfaceType: SurfaceType }
  >();
  /** @internal */ lastSurfaceAction = new Map<
    string,
    { actionId: string; data?: Record<string, unknown> }
  >();
  /** @internal */ surfaceState = new Map<
    string,
    {
      surfaceType: SurfaceType;
      data: SurfaceData;
      title?: string;
      actions?: Array<{
        id: string;
        label: string;
        style?: string;
        data?: Record<string, unknown>;
      }>;
    }
  >();
  /** @internal */ surfaceUndoStacks = new Map<string, string[]>();
  /** @internal */ accumulatedSurfaceState = new Map<
    string,
    Record<string, unknown>
  >();
  /** @internal */ broadcastToAllClients?: (msg: ServerMessage) => void;
  /** @internal */ withSurface = createSurfaceMutex();
  /** @internal */ currentTurnSurfaces: Array<{
    surfaceId: string;
    surfaceType: SurfaceType;
    title?: string;
    data: SurfaceData;
    actions?: Array<{ id: string; label: string; style?: string }>;
    display?: string;
    persistent?: boolean;
  }> = [];
  /** @internal */ workspaceTopLevelContext: string | null = null;
  /** @internal */ workspaceTopLevelDirty = true;
  /**
   * Host home directory reported by the client (e.g. macOS
   * `NSHomeDirectory()`). Populated from `HostProxyTransportMetadata` when
   * a message arrives from an interface that supports host-proxy tools
   * (see `supportsHostProxy`). Consumed by the `<workspace>` block renderer
   * so platform-managed (containerized) daemons show the user's actual
   * client-side home dir instead of the container's `os.homedir()`.
   * @internal
   */
  hostHomeDir?: string;
  /**
   * Host username reported by the client (e.g. macOS `NSUserName()`).
   * See `hostHomeDir`.
   * @internal
   */
  hostUsername?: string;
  public readonly traceEmitter: TraceEmitter;
  /** @internal */ hasSystemPromptOverride: boolean;
  public memoryPolicy: ConversationMemoryPolicy;
  /** @internal */ readonly graphMemory: ConversationGraphMemory;
  /** @internal */ activeContextNodeIds?: string[];
  /** @internal */ memoryScopeId?: string;
  /** @internal */ streamThinking: boolean;
  /** @internal */ turnCount = 0;
  public lastAssistantAttachments: AssistantAttachmentDraft[] = [];
  public lastAttachmentWarnings: string[] = [];
  /**
   * Pre-chat onboarding context provided by the native client.
   * In-memory only — not persisted to the DB. Only relevant for the first
   * turn of a brand-new conversation so the system prompt can personalize
   * the opener and skip redundant discovery.
   * @internal
   */
  private onboardingContext?: OnboardingContext;
  /** @internal */ currentTurnChannelContext: TurnChannelContext | null = null;
  /** @internal */ currentTurnInterfaceContext: TurnInterfaceContext | null =
    null;
  /** @internal */ activityVersion = 0;
  /** Last emitted activity state message, retained for replay on SSE reconnection. */
  /** @internal */ lastActivityStateMsg: ServerMessage | null = null;
  /** Set by the agent loop to track confirmation outcomes for persistence. */
  onConfirmationOutcome?: (
    requestId: string,
    state: string,
    toolName?: string,
    toolUseId?: string,
  ) => void;

  constructor(
    conversationId: string,
    provider: Provider,
    systemPrompt: string,
    maxTokens: number,
    sendToClient: (msg: ServerMessage) => void,
    workingDir: string,
    broadcastToAllClients?: (msg: ServerMessage) => void,
    memoryPolicy?: ConversationMemoryPolicy,
    sharedCesClient?: CesClient,
    speedOverride?: Speed,
    cacheTtl?: "5m" | "1h",
    modelIntent?: ModelIntent,
    modelOverride?: string,
  ) {
    this.conversationId = conversationId;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.broadcastToAllClients = broadcastToAllClients;
    this.memoryPolicy = memoryPolicy
      ? { ...memoryPolicy }
      : { ...DEFAULT_MEMORY_POLICY };
    this.graphMemory = new ConversationGraphMemory(
      this.memoryPolicy.scopeId,
      conversationId,
    );
    this.traceEmitter = new TraceEmitter(conversationId, sendToClient);
    this.prompter = new PermissionPrompter(sendToClient);
    this.prompter.setOnStateChanged((requestId, state, source, toolUseId) => {
      // Route through emitConfirmationStateChanged so the event reaches
      // the client via sendToClient (wired to the SSE hub for HTTP conversations).
      this.emitConfirmationStateChanged({
        conversationId: this.conversationId,
        requestId,
        state,
        source,
        toolUseId,
      });
      // Notify the agent loop so it can track requestId → toolUseId mappings
      // and record confirmation outcomes for persistence.
      this.onConfirmationOutcome?.(requestId, state, undefined, toolUseId);
      // Emit activity state transitions for confirmation lifecycle
      if (state === "pending") {
        this.emitActivityState(
          "awaiting_confirmation",
          "confirmation_requested",
          "assistant_turn",
        );
      } else if (state === "timed_out") {
        this.emitActivityState(
          "thinking",
          "confirmation_resolved",
          "assistant_turn",
          undefined,
          "Resuming after timeout",
        );
      }
    });
    this.secretPrompter = new SecretPrompter(sendToClient);

    // Register watch/call notifiers (reads ctx properties lazily)
    registerConversationNotifiers(conversationId, this);

    // Tool infrastructure
    this.executor = new ToolExecutor(this.prompter);
    this.profiler = new ToolProfiler();
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolNotificationListener(this.eventBus, (msg) =>
      this.sendToClient(msg),
    );
    registerToolTraceListener(this.eventBus, this.traceEmitter);
    registerToolProfilingListener(this.eventBus, this.profiler);
    registerToolPermissionTelemetryListener(this.eventBus);
    const auditToolLifecycleEvent = createToolAuditListener();
    const publishToolDomainEvent = createToolDomainEventPublisher(
      this.eventBus,
    );
    const handleToolLifecycleEvent = (
      event: import("../tools/types.js").ToolLifecycleEvent,
    ) => {
      auditToolLifecycleEvent(event);
      return publishToolDomainEvent(event);
    };

    const toolDefs = buildToolDefinitions();
    this.coreToolNames = new Set(toolDefs.map((d) => d.name));
    const toolExecutor = createToolExecutor(
      this.executor,
      this.prompter,
      this.secretPrompter,
      this as ToolSetupContext,
      handleToolLifecycleEvent,
      broadcastToAllClients,
    );

    const config = getConfig();
    this.streamThinking = config.thinking.streamThinking ?? false;

    // CES (Credential Execution Service) — use the shared server-level client.
    // The CES sidecar accepts exactly one bootstrap connection, so the
    // client is owned by DaemonServer and passed in here.
    if (sharedCesClient) {
      this.cesClient = sharedCesClient;
    }

    const resolveTools = createResolveToolsCallback(toolDefs, this);

    const configuredMaxTokens = maxTokens;
    // When a systemPromptOverride was provided, use it as-is; otherwise
    // rebuild the full prompt each turn (picks up any workspace file changes).
    const hasSystemPromptOverride = systemPrompt !== buildSystemPrompt();
    this.hasSystemPromptOverride = hasSystemPromptOverride;

    // If an explicit modelOverride is supplied, use it verbatim. Otherwise,
    // if modelIntent is set, resolve it against the active provider's
    // intent → model mapping. The AgentLoop passes the resulting string
    // through to `providerConfig.model` on every turn.
    const resolvedModel: string | undefined =
      modelOverride ??
      (modelIntent
        ? resolveModelIntent(provider.name, modelIntent)
        : undefined);

    const resolveSystemPromptCallback = (
      _history: import("../providers/types.js").Message[],
    ): ResolvedSystemPrompt => {
      const resolved: ResolvedSystemPrompt = {
        systemPrompt: this.hasSystemPromptOverride
          ? systemPrompt
          : (() => {
              const persona = resolvePersonaContext(
                this.currentTurnTrustContext,
                this.currentTurnChannelCapabilities,
              );
              return buildSystemPrompt({
                hasNoClient: this.hasNoClient,
                userPersona: persona.userPersona,
                channelPersona: persona.channelPersona,
                userSlug: persona.userSlug,
                onboardingContext: this.getOnboardingContext(),
              });
            })(),
        maxTokens: configuredMaxTokens,
      };
      if (resolvedModel !== undefined) {
        resolved.model = resolvedModel;
      }
      return resolved;
    };

    const fastModeEnabled = isAssistantFeatureFlagEnabled("fast-mode", config);
    const resolvedSpeed = speedOverride ?? config.speed;

    this.agentLoop = new AgentLoop(
      provider,
      systemPrompt,
      {
        maxTokens,
        maxInputTokens: config.contextWindow.maxInputTokens,
        thinking: config.thinking,
        effort: config.effort,
        ...(fastModeEnabled && resolvedSpeed === "fast"
          ? { speed: resolvedSpeed }
          : {}),
        ...(cacheTtl ? { cacheTtl } : {}),
      },
      toolDefs.length > 0 ? toolDefs : undefined,
      toolDefs.length > 0 ? toolExecutor : undefined,
      resolveTools,
      resolveSystemPromptCallback,
    );
    this.contextWindowManager = new ContextWindowManager({
      provider,
      systemPrompt: () => resolveSystemPromptCallback([]).systemPrompt,
      config: config.contextWindow,
      toolTokenBudget: this.agentLoop.getToolTokenBudget(),
    });

    void getHookManager().trigger("conversation-start", {
      conversationId: this.conversationId,
      workingDir: this.workingDir,
    });
  }

  // ── Onboarding context ───────────────────────────────────────────

  setOnboardingContext(ctx: OnboardingContext): void {
    this.onboardingContext = ctx;
  }

  getOnboardingContext(): OnboardingContext | undefined {
    return this.onboardingContext;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async loadFromDb(): Promise<void> {
    await loadFromDbImpl(this);
    this.restoreSurfaceStateFromHistory();
    this.graphMemory.restoreState();
  }

  /**
   * Scan loaded conversation history for ui_surface content blocks and
   * populate surfaceState so that findConversationBySurfaceId works for
   * surfaces restored from history (e.g. after daemon restart).
   *
   * Only scans live (non-compacted) messages in this.messages — not all DB
   * rows — because surface IDs are not globally unique and restoring stale
   * compacted surfaces would let findConversationBySurfaceId route actions
   * to the wrong conversation.
   */
  private restoreSurfaceStateFromHistory(): void {
    this.surfaceState.clear();
    for (const msg of this.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === "ui_surface" && typeof b.surfaceId === "string") {
          this.surfaceState.set(b.surfaceId, {
            surfaceType: (b.surfaceType ?? "dynamic_page") as SurfaceType,
            data: (b.data ?? {}) as SurfaceData,
            title: b.title as string | undefined,
            actions: Array.isArray(b.actions)
              ? (b.actions as Array<{
                  id: string;
                  label: string;
                  style?: string;
                  data?: Record<string, unknown>;
                }>)
              : undefined,
          });
        }
      }
    }
  }

  async ensureActorScopedHistory(): Promise<void> {
    const currentTrustClass = this.trustContext?.trustClass;
    if (this.loadedHistoryTrustClass === currentTrustClass) return;
    await this.loadFromDb();
  }

  updateClient(
    sendToClient: (msg: ServerMessage) => void,
    hasNoClient = false,
    opts?: { skipProxySenderUpdate?: boolean },
  ): void {
    this.sendToClient = sendToClient;
    this.hasNoClient = hasNoClient;
    this.prompter.updateSender(sendToClient);
    this.secretPrompter.updateSender(sendToClient);
    this.traceEmitter.updateSender(sendToClient);
    if (!opts?.skipProxySenderUpdate) {
      this.hostBashProxy?.updateSender(sendToClient, !hasNoClient);
      this.hostBrowserProxy?.updateSender(sendToClient, !hasNoClient);
      this.hostCuProxy?.updateSender(sendToClient, !hasNoClient);
      this.hostFileProxy?.updateSender(sendToClient, !hasNoClient);
    }

    // Replay last activity state so a reconnecting client sees the current phase
    // instead of being stuck on the last state it received before disconnection.
    if (!hasNoClient && this.lastActivityStateMsg) {
      try {
        sendToClient(this.lastActivityStateMsg);
      } catch (err) {
        log.warn(
          { err, conversationId: this.conversationId },
          "Failed to replay activity state on client reconnection",
        );
      }
    }
  }

  /** Returns the current sendToClient reference for identity comparison. */
  getCurrentSender(): (msg: ServerMessage) => void {
    return this.sendToClient;
  }

  /** Mark host proxies as unavailable so tool execution uses local fallback. */
  clearProxyAvailability(): void {
    this.hostBashProxy?.updateSender(this.sendToClient, false);
    this.hostBrowserProxy?.updateSender(this.sendToClient, false);
    this.hostCuProxy?.updateSender(this.sendToClient, false);
    this.hostFileProxy?.updateSender(this.sendToClient, false);
  }

  /**
   * Restore host proxy availability based on whether a real client is connected.
   * When `skipBrowser` is true, the browser proxy is left untouched — use this
   * when `restoreBrowserProxyAvailability()` will handle the browser proxy
   * separately with the correct registry-routed sender.
   */
  restoreProxyAvailability(options?: { skipBrowser?: boolean }): void {
    if (!this.hasNoClient) {
      this.hostBashProxy?.updateSender(this.sendToClient, true);
      if (!options?.skipBrowser) {
        this.hostBrowserProxy?.updateSender(this.sendToClient, true);
      }
      this.hostCuProxy?.updateSender(this.sendToClient, true);
      this.hostFileProxy?.updateSender(this.sendToClient, true);
    }
  }

  /**
   * Restore host browser proxy availability only. Used for interfaces that
   * support host_browser but not the full desktop proxy set, so calling
   * restoreProxyAvailability() would incorrectly re-enable bash/file/CU
   * proxies that should stay disabled. Applicable to chrome-extension turns
   * (which only support host_browser) and macOS turns with an active
   * extension connection (which route browser tools through the extension
   * registry instead of cdp-inspect/local).
   *
   * Unlike `restoreProxyAvailability()`, this helper does NOT gate on
   * `hasNoClient`. The chrome-extension interface is non-interactive (so
   * `hasNoClient === true`), but it DOES have a connected client that can
   * service `host_browser_request` events. Gating on `hasNoClient` would
   * leave the just-constructed proxy unavailable and the only way to make
   * it available would be to flip `hasNoClient` false, which would
   * incorrectly enable host_bash/host_file/host_cu tool gating downstream.
   *
   * When `hostBrowserSenderOverride` is set, that function is used as the
   * sender instead of `sendToClient`. This is required for any interface
   * whose host_browser frames route through the ChromeExtensionRegistry
   * WebSocket rather than the SSE hub: if the queue-drain path called this
   * helper with `sendToClient`, the registry-routed sender established at
   * turn-start would be clobbered by the SSE hub emitter and
   * host_browser_request frames would stop reaching the extension.
   *
   * Callers must only invoke this when they know the current interface
   * supports host_browser (see `supportsHostProxy(id, "host_browser")`)
   * or has an active extension connection with a registry-routed sender.
   */
  restoreBrowserProxyAvailability(): void {
    const sender = this.hostBrowserSenderOverride ?? this.sendToClient;
    this.hostBrowserProxy?.updateSender(sender, true);
  }

  setSubagentAllowedTools(tools: Set<string> | undefined): void {
    this.subagentAllowedTools = tools;
  }

  setIsSubagent(value: boolean): void {
    this.isSubagent = value;
  }

  /**
   * Prepend inherited parent messages into the in-memory message array so that
   * the AgentLoop includes them in provider calls (enabling KV cache sharing).
   *
   * These messages are NOT persisted to the database — they exist only in
   * memory. When the conversation is later read from DB via getMessages(),
   * only the conversation's own persisted messages appear.
   *
   * Must be called before the first persistUserMessage() call — i.e. while
   * `this.messages` is still empty.
   */
  injectInheritedContext(messages: Message[]): void {
    if (this.messages.length !== 0) {
      throw new Error(
        "injectInheritedContext must be called before any messages have been added",
      );
    }
    this.messages = [...messages];
    this.contextWindowManager.nonPersistedPrefixCount = messages.length;
    this.contextWindowManager.summaryIsInjected =
      getSummaryFromContextMessage(messages[0]) != null;
  }

  /**
   * Return the system prompt string set at construction time (or its override).
   * Fork consumers use this to pass the parent's system prompt to the fork.
   */
  getCurrentSystemPrompt(): string {
    return this.systemPrompt;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  markStale(): void {
    this.stale = true;
    // Invalidate the cached skill catalog so the next projection picks up
    // filesystem changes (e.g. a skill created during this run).
    this.skillProjectionCache.catalog = undefined;
  }

  isStale(): boolean {
    return this.stale;
  }

  abort(reason?: AbortReason): void {
    abortConversation(this, reason);
  }

  dispose(): void {
    approvalOverrides.clearMode(this.conversationId);
    this.hostBashProxy?.dispose();
    this.hostBrowserProxy?.dispose();
    this.hostCuProxy?.dispose();
    this.hostFileProxy?.dispose();
    // CES client is owned by DaemonServer — just drop the reference.
    // Do NOT close it here; the server manages the CES lifecycle.
    this.cesClient = undefined;
    this.activeContextNodeIds = this.graphMemory.tracker.getActiveNodeIds();
    this.memoryScopeId = this.memoryPolicy.scopeId;
    this.graphMemory.persistState();
    disposeConversation(this);
  }

  // ── Messaging ────────────────────────────────────────────────────

  redirectToSecurePrompt(
    detectedTypes: string[],
    options?: RedirectToSecurePromptOptions,
  ): void {
    redirectToSecurePromptImpl(
      this.conversationId,
      this.secretPrompter,
      detectedTypes,
      options,
    );
  }

  enqueueMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent: (msg: ServerMessage) => void,
    requestId: string,
    activeSurfaceId?: string,
    currentPage?: string,
    metadata?: Record<string, unknown>,
    options?: { isInteractive?: boolean },
    displayContent?: string,
    transport?: ConversationTransportMetadata,
  ): { queued: boolean; requestId: string; rejected?: boolean } {
    return enqueueMessageImpl(
      this,
      content,
      attachments,
      onEvent,
      requestId,
      activeSurfaceId,
      currentPage,
      metadata,
      options,
      displayContent,
      transport,
    );
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  hasQueuedMessages(): boolean {
    return !this.queue.isEmpty;
  }

  removeQueuedMessage(requestId: string): boolean {
    return this.queue.removeByRequestId(requestId) !== undefined;
  }

  canHandoffAtCheckpoint(): boolean {
    return this.processing && this.hasQueuedMessages();
  }

  hasPendingConfirmation(requestId: string): boolean {
    return this.prompter.hasPendingRequest(requestId);
  }

  hasAnyPendingConfirmation(): boolean {
    return this.prompter.hasPending;
  }

  denyAllPendingConfirmations(): void {
    this.prompter.denyAllPending();
  }

  hasPendingSecret(requestId: string): boolean {
    return this.secretPrompter.hasPendingRequest(requestId);
  }

  handleConfirmationResponse(
    requestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    selectedScope?: string,
    decisionContext?: string,
    emissionContext?: {
      source?: ConfirmationStateChanged["source"];
      causedByRequestId?: string;
      decisionText?: string;
    },
  ): void {
    // Guard: only proceed if the confirmation is still pending. Stale or
    // already-resolved requests must not activate overrides or emit events.
    if (!this.prompter.hasPendingRequest(requestId)) {
      return;
    }

    const hostAccessEnablePrompt =
      this.prompter.isHostAccessEnablePrompt(requestId) ||
      isConversationHostAccessEnablePrompt(
        pendingInteractions.get(requestId)?.confirmationDetails,
      );
    const effectiveDecision =
      hostAccessEnablePrompt && !isConversationHostAccessDecision(decision)
        ? "deny"
        : decision;

    if (
      hostAccessEnablePrompt &&
      effectiveDecision === "allow" &&
      !isConversationHostAccessEnabled(this.conversationId)
    ) {
      updateConversationHostAccess(this.conversationId, true);
      this.sendToClient({
        type: "conversation_host_access_updated",
        conversationId: this.conversationId,
        hostAccess: true,
      });
    }

    // Capture toolUseId before resolving (resolution deletes the pending entry)
    const toolUseId = this.prompter.getToolUseId(requestId);

    this.prompter.resolveConfirmation(
      requestId,
      effectiveDecision,
      selectedPattern,
      selectedScope,
      decisionContext,
    );

    // Mode activation (setTimedMode / setConversationMode) is intentionally NOT
    // done here. It is handled in permission-checker.ts where the
    // guardian trust-class and conversation context are available.

    // Emit authoritative confirmation state and activity transition centrally
    // so ALL callers (HTTP handlers, /v1/confirm, channel bridges) get
    // consistent events without duplicating emission logic.
    const resolvedState =
      effectiveDecision === "deny" || effectiveDecision === "always_deny"
        ? ("denied" as const)
        : ("approved" as const);
    this.emitConfirmationStateChanged({
      conversationId: this.conversationId,
      requestId,
      state: resolvedState,
      source: emissionContext?.source ?? "button",
      toolUseId,
      ...(emissionContext?.causedByRequestId
        ? { causedByRequestId: emissionContext.causedByRequestId }
        : {}),
      ...(emissionContext?.decisionText
        ? { decisionText: emissionContext.decisionText }
        : {}),
    });
    // Notify the agent loop of the confirmation outcome for persistence
    this.onConfirmationOutcome?.(
      requestId,
      resolvedState,
      undefined,
      toolUseId,
    );
    this.emitActivityState(
      "thinking",
      "confirmation_resolved",
      "assistant_turn",
      undefined,
      "Resuming after approval",
    );

    // Sync the canonical guardian request status so stale "pending" DB
    // records don't get matched by later guardian reply routing. Best-effort:
    // CAS may harmlessly fail if the canonical decision primitive already
    // resolved the request (e.g. channel approval path).
    try {
      resolveCanonicalGuardianRequest(requestId, "pending", {
        status: resolvedState,
      });
    } catch {
      // Canonical request tracking should not break the primary approval flow.
    }

    // Cascade to other pending confirmations that match this decision
    this.cascadePendingApprovals(
      requestId,
      effectiveDecision,
      selectedPattern,
      hostAccessEnablePrompt,
    );
  }

  /**
   * After resolving one confirmation, auto-resolve other pending
   * confirmations in the same conversation that match the decision.
   *
   * - allow_10m / allow_conversation → approve ALL pending in conversation
   * - always_allow / always_allow_high_risk → approve pattern-matching pending
   * - always_deny → deny pattern-matching pending
   * - allow / deny (one-time) → no cascading
   */
  private cascadePendingApprovals(
    primaryRequestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    hostAccessEnablePrompt = false,
  ): void {
    // Single-action decisions don't cascade
    if (decision === "allow" || decision === "deny") {
      if (!hostAccessEnablePrompt || decision !== "allow") {
        return;
      }
    }

    const pendingRequestIds = this.prompter.getPendingRequestIds();
    if (pendingRequestIds.length === 0) return;

    for (const candidateId of pendingRequestIds) {
      if (candidateId === primaryRequestId) continue;

      const interaction = pendingInteractions.get(candidateId);
      if (!interaction) continue;
      if (interaction.conversationId !== this.conversationId) continue;
      if (interaction.kind !== "confirmation") continue;

      if (
        hostAccessEnablePrompt &&
        (this.prompter.isHostAccessEnablePrompt(candidateId) ||
          isConversationHostAccessEnablePrompt(interaction.confirmationDetails))
      ) {
        // Enabling computer access is conversation-scoped, so sibling host
        // prompts should resolve immediately once the first approval lands.
        pendingInteractions.resolve(candidateId);
        this.handleConfirmationResponse(
          candidateId,
          "allow",
          undefined,
          undefined,
          undefined,
          {
            source: "system",
            causedByRequestId: primaryRequestId,
          },
        );
        continue;
      }

      const cascadeResult = this.shouldCascade(
        decision,
        selectedPattern,
        interaction.confirmationDetails,
      );
      if (!cascadeResult) continue;

      // Consume from pending-interactions tracker
      pendingInteractions.resolve(candidateId);

      // Resolve via handleConfirmationResponse which emits events and
      // syncs canonical status. Use simple "allow"/"deny" so the
      // permission-checker won't save duplicate rules or re-activate
      // temporary modes. Recursion terminates because allow/deny exit
      // cascadePendingApprovals early.
      this.handleConfirmationResponse(
        candidateId,
        cascadeResult.allow ? "allow" : "deny",
        undefined,
        undefined,
        undefined,
        {
          source: "system",
          causedByRequestId: primaryRequestId,
        },
      );
    }
  }

  /**
   * Determine whether a pending confirmation should be auto-resolved
   * based on the cascading decision and pattern.
   */
  private shouldCascade(
    decision: UserDecision,
    selectedPattern: string | undefined,
    details?: import("../runtime/pending-interactions.js").ConfirmationDetails,
  ): { allow: boolean } | null {
    // Temporary overrides apply to the entire conversation
    if (decision === "allow_10m" || decision === "allow_conversation") {
      return { allow: true };
    }

    // Persistent allow: cascade if the pattern matches any allowlist candidate.
    // "always_allow" must NOT cascade to high-risk pending confirmations —
    // only "always_allow_high_risk" has consent for those.
    if (
      (decision === "always_allow" || decision === "always_allow_high_risk") &&
      selectedPattern &&
      details
    ) {
      if (decision === "always_allow" && details.riskLevel === "high") {
        return null;
      }
      for (const option of details.allowlistOptions) {
        if (patternMatchesCandidate(selectedPattern, option.pattern)) {
          return { allow: true };
        }
      }
      return null;
    }

    // Persistent deny: cascade denial if the pattern matches
    if (decision === "always_deny" && selectedPattern && details) {
      for (const option of details.allowlistOptions) {
        if (patternMatchesCandidate(selectedPattern, option.pattern)) {
          return { allow: false };
        }
      }
      return null;
    }

    return null;
  }

  handleSecretResponse(
    requestId: string,
    value?: string,
    delivery?: "store" | "transient_send",
  ): void {
    this.secretPrompter.resolveSecret(requestId, value, delivery);
  }

  resolveHostBash(
    requestId: string,
    response: {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    },
  ): void {
    this.hostBashProxy?.resolve(requestId, response);
  }

  setHostBashProxy(proxy: HostBashProxy | undefined): void {
    if (this.hostBashProxy && this.hostBashProxy !== proxy) {
      this.hostBashProxy.dispose();
    }
    this.hostBashProxy = proxy;
  }

  resolveHostBrowser(
    requestId: string,
    response: { content: string; isError: boolean },
  ): void {
    this.hostBrowserProxy?.resolve(requestId, response);
  }

  setHostBrowserProxy(proxy: HostBrowserProxy | undefined): void {
    if (this.hostBrowserProxy && this.hostBrowserProxy !== proxy) {
      this.hostBrowserProxy.dispose();
    }
    this.hostBrowserProxy = proxy;
  }

  resolveHostFile(
    requestId: string,
    response: { content: string; isError: boolean; imageData?: string },
  ): void {
    this.hostFileProxy?.resolve(requestId, response);
  }

  setHostFileProxy(proxy: HostFileProxy | undefined): void {
    if (this.hostFileProxy && this.hostFileProxy !== proxy) {
      this.hostFileProxy.dispose();
    }
    this.hostFileProxy = proxy;
  }

  resolveHostCu(requestId: string, observation: CuObservationResult): void {
    this.hostCuProxy?.resolve(requestId, observation);
  }

  setHostCuProxy(proxy: HostCuProxy | undefined): void {
    if (this.hostCuProxy && this.hostCuProxy !== proxy) {
      this.hostCuProxy.dispose();
    }
    this.hostCuProxy = proxy;
  }

  // ── Server-authoritative state signals ─────────────────────────────

  emitConfirmationStateChanged(
    params: Omit<ConfirmationStateChanged, "type">,
  ): void {
    const msg: ServerMessage = {
      type: "confirmation_state_changed",
      ...params,
    } as ServerMessage;
    try {
      this.sendToClient(msg);
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId },
        "sendToClient threw in emitConfirmationStateChanged",
      );
    }
  }

  emitActivityState(
    phase: AssistantActivityState["phase"],
    reason: AssistantActivityState["reason"],
    anchor: AssistantActivityState["anchor"] = "assistant_turn",
    requestId?: string,
    statusText?: string,
  ): void {
    this.activityVersion++;
    const msg: ServerMessage = {
      type: "assistant_activity_state",
      conversationId: this.conversationId,
      activityVersion: this.activityVersion,
      phase,
      anchor,
      requestId,
      reason,
      ...(statusText ? { statusText } : {}),
    } as ServerMessage;
    this.lastActivityStateMsg = msg;
    try {
      this.sendToClient(msg);
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId },
        "sendToClient threw in emitActivityState",
      );
    }
  }

  async forceCompact(): Promise<ContextWindowResult> {
    const result = await this.contextWindowManager.maybeCompact(
      this.messages,
      this.abortController?.signal ?? undefined,
      { force: true, lastCompactedAt: this.contextCompactedAt ?? undefined },
    );
    if (result.compacted) {
      this.messages = result.messages;
      this.contextCompactedMessageCount += result.compactedPersistedMessages;
      this.contextCompactedAt = Date.now();
      updateConversationContextWindow(
        this.conversationId,
        result.summaryText,
        this.contextCompactedMessageCount,
      );
      // Fire auto-analysis on compaction so the reflective agent can
      // crystallize anything worth remembering before the context window
      // narrows further.
      enqueueAutoAnalysisOnCompaction(
        this.conversationId,
        this.trustContext?.trustClass,
      );
    }
    return result;
  }

  setChannelCapabilities(caps: ChannelCapabilities | null): void {
    this.channelCapabilities = caps ?? undefined;
  }

  setTrustContext(ctx: TrustContext | null): void {
    this.trustContext = ctx ?? undefined;
  }

  setAuthContext(ctx: AuthContext | null): void {
    this.authContext = ctx ?? undefined;
  }

  getAuthContext(): AuthContext | undefined {
    return this.authContext;
  }

  setVoiceCallControlPrompt(prompt: string | null): void {
    this.voiceCallControlPrompt = prompt ?? undefined;
  }

  setTransportHints(hints: string[] | undefined): void {
    this.transportHints = hints;
  }

  /**
   * Apply client-reported host environment (home dir, username) from
   * transport metadata onto the conversation. Only interfaces whose
   * interfaceId passes `supportsHostProxy()` contribute values — all other
   * interfaces (CLI, channels, iOS, chrome-extension) clear any previously
   * stored values so a conversation reused across interfaces doesn't leak
   * stale paths into later `<workspace>` blocks.
   *
   * Gating on `supportsHostProxy` (rather than a specific interface name)
   * keeps this in lock-step with the capability set defined in
   * `HostProxyInterfaceId` — adding a new host-capable client only requires
   * extending those two, not touching this method.
   *
   * Invalidates the cached workspace top-level block when values change so
   * the next render picks up the new host env.
   */
  applyHostEnvFromTransport(transport: ConversationTransportMetadata): void {
    const prevHomeDir = this.hostHomeDir;
    const prevUsername = this.hostUsername;
    if (isHostProxyTransport(transport)) {
      this.hostHomeDir = transport.hostHomeDir;
      this.hostUsername = transport.hostUsername;
    } else {
      this.hostHomeDir = undefined;
      this.hostUsername = undefined;
    }
    if (
      prevHomeDir !== this.hostHomeDir ||
      prevUsername !== this.hostUsername
    ) {
      this.workspaceTopLevelDirty = true;
    }
  }

  setAssistantId(assistantId: string | null): void {
    this.assistantId = assistantId ?? undefined;
  }

  setCommandIntent(
    intent: { type: string; payload?: string; languageCode?: string } | null,
  ): void {
    this.commandIntent = intent ?? undefined;
  }

  setPreactivatedSkillIds(ids: string[] | undefined): void {
    this.preactivatedSkillIds = ids;
  }

  /**
   * Add a skill ID to the preactivated set without replacing existing entries.
   * No-op if the ID is already present.
   */
  addPreactivatedSkillId(id: string): void {
    if (!this.preactivatedSkillIds) {
      this.preactivatedSkillIds = [id];
    } else if (!this.preactivatedSkillIds.includes(id)) {
      this.preactivatedSkillIds.push(id);
    }
  }

  setTurnChannelContext(ctx: TurnChannelContext): void {
    this.currentTurnChannelContext = ctx;
  }

  getTurnChannelContext(): TurnChannelContext | null {
    return this.currentTurnChannelContext;
  }

  setTurnInterfaceContext(ctx: TurnInterfaceContext): void {
    this.currentTurnInterfaceContext = ctx;
  }

  getTurnInterfaceContext(): TurnInterfaceContext | null {
    return this.currentTurnInterfaceContext;
  }

  /**
   * Implements the `transportInterface` field of `SkillProjectionContext` so
   * that `isToolActiveForContext` can gate host tools by per-capability
   * `supportsHostProxy(transport, capability)`. Derived from the live turn
   * interface context so it tracks the connected client across turns.
   */
  get transportInterface(): InterfaceId | undefined {
    return this.currentTurnInterfaceContext?.userMessageInterface;
  }

  async persistUserMessage(
    content: string,
    attachments: UserMessageAttachment[],
    requestId?: string,
    metadata?: Record<string, unknown>,
    displayContent?: string,
  ): Promise<string> {
    if (!this.processing) {
      await this.ensureActorScopedHistory();
    }
    return persistUserMessageImpl(
      this,
      content,
      attachments,
      requestId,
      metadata,
      displayContent,
    );
  }

  // ── Agent Loop ───────────────────────────────────────────────────

  async runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: {
      skipPreMessageRollback?: boolean;
      isInteractive?: boolean;
      isUserMessage?: boolean;
      titleText?: string;
    },
  ): Promise<void> {
    return runAgentLoopImpl(this, content, userMessageId, onEvent, options);
  }

  drainQueue(reason: QueueDrainReason = "loop_complete"): Promise<void> {
    return drainQueueImpl(this as ProcessConversationContext, reason);
  }

  async processMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent: (msg: ServerMessage) => void,
    requestId?: string,
    activeSurfaceId?: string,
    currentPage?: string,
    options?: { isInteractive?: boolean },
    displayContent?: string,
  ): Promise<string> {
    return processMessageImpl(
      this as ProcessConversationContext,
      content,
      attachments,
      onEvent,
      requestId,
      activeSurfaceId,
      currentPage,
      options,
      displayContent,
    );
  }

  // ── History ──────────────────────────────────────────────────────

  getMessages(): Message[] {
    return this.messages;
  }

  undo(): number {
    return undoImpl(this as HistoryConversationContext);
  }

  async regenerate(
    onEvent: (msg: ServerMessage) => void,
    requestId?: string,
  ): Promise<void> {
    return regenerateImpl(
      this as HistoryConversationContext,
      onEvent,
      requestId,
    );
  }

  // ── Surfaces ─────────────────────────────────────────────────────

  handleSurfaceAction(
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ): Promise<SurfaceActionResult> {
    return handleSurfaceActionImpl(this, surfaceId, actionId, data);
  }

  handleSurfaceUndo(surfaceId: string): void {
    handleSurfaceUndoImpl(this, surfaceId);
  }

  // ── Workspace ────────────────────────────────────────────────────

  refreshWorkspaceTopLevelContextIfNeeded(): void {
    refreshWorkspaceImpl(this);
  }

  markWorkspaceTopLevelDirty(): void {
    this.workspaceTopLevelDirty = true;
  }

  getWorkspaceTopLevelContext(): string | null {
    return this.workspaceTopLevelContext;
  }

  isWorkspaceTopLevelDirty(): boolean {
    return this.workspaceTopLevelDirty;
  }
}
