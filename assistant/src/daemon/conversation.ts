/**
 * Conversation — thin coordinator that delegates to extracted modules.
 *
 * Each concern lives in its own file:
 * - conversation-lifecycle.ts    — loadFromDb, abort, dispose
 * - conversation-messaging.ts    — enqueueMessage, persistUserMessage, redirectToSecurePrompt
 * - conversation-agent-loop.ts   — runAgentLoop, generateTitle
 * - conversation-notifiers.ts    — call notifier registration
 * - conversation-tool-setup.ts   — tool definitions, executor, resolveTools callback
 * - conversation-media-retry.ts  — media trimming + raceWithTimeout
 * - conversation-process.ts      — drainQueue, processMessage
 * - conversation-history.ts      — undo, consolidateAssistantMessages
 * - conversation-surfaces.ts     — handleSurfaceAction, handleSurfaceUndo
 * - conversation-workspace.ts    — refreshWorkspaceTopLevelContext
 * - conversation-usage.ts        — recordUsage
 */

import type { AgentLoopConfig, ResolvedSystemPrompt } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type {
  InterfaceId,
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import {
  contextWindowConfigFromEffective,
  resolveEffectiveContextWindow,
} from "../config/llm-context-resolution.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite, Speed } from "../config/schemas/llm.js";
import type { ContextWindowConfig } from "../config/types.js";
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
import { registerToolPermissionTelemetryListener } from "../events/tool-permission-telemetry-listener.js";
import {
  registerToolProfilingListener,
  ToolProfiler,
} from "../events/tool-profiling-listener.js";
import { registerToolTraceListener } from "../events/tool-trace-listener.js";
import { resolveCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import {
  getConversation,
  getConversationOriginChannel,
  getConversationOverrideProfileFromRow,
} from "../memory/conversation-crud.js";
import { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { SecretPrompter } from "../permissions/secret-prompter.js";
import type { UserDecision } from "../permissions/types.js";
import { resolvePersonaContext } from "../prompts/persona-resolver.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import type { Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import type { AuthContext } from "../runtime/auth/types.js";
import type { InteractiveUiResult } from "../runtime/interactive-ui.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolLifecycleEvent } from "../tools/types.js";
import type { OnboardingContext } from "../types/onboarding-context.js";
import type { AbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import type { AssistantAttachmentDraft } from "./assistant-attachments.js";
import {
  applyCompactionResult,
  runAgentLoopImpl,
  trackCompactionOutcome,
} from "./conversation-agent-loop.js";
import type { HistoryConversationContext } from "./conversation-history.js";
import { undo as undoImpl } from "./conversation-history.js";
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
import {
  type ChannelCapabilities,
  getSlackCompactionWatermarkForPrefix,
  loadSlackChronologicalContext,
} from "./conversation-runtime-assembly.js";
import type { SkillProjectionCache } from "./conversation-skill-tools.js";
import {
  createSurfaceMutex,
  flushPendingSurfaceDataPersists,
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
import { canonicalizeTimeZone } from "./date-context.js";
import type { HostAppControlProxy } from "./host-app-control-proxy.js";
import { HostCuProxy } from "./host-cu-proxy.js";
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

export { findLastUndoableUserMessageIndex } from "./conversation-history.js";
export type {
  QueueDrainReason,
  QueuePolicy,
} from "./conversation-queue-manager.js";
import type { TrustContext } from "./trust-context.js";

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
  /** @internal */ diskPressureCleanupModeActive?: boolean;
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
  /** @internal */ hostCuProxy?: HostCuProxy;
  /**
   * Per-conversation host app-control proxy. Set via
   * `setHostAppControlProxy` and disposed in `dispose()`. The
   * `/v1/host-app-control-result` route forwards result payloads to the
   * awaiting promise via this reference.
   * @internal
   */
  hostAppControlProxy?: HostAppControlProxy;
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
  /** @internal */ currentTurnOverrideProfile?: string;
  /** @internal */ authContext?: AuthContext;
  /** @internal */ loadedHistoryTrustClass?: TrustClass;
  /** @internal */ voiceCallControlPrompt?: string;
  /** @internal */ transportHints?: string[];
  /** @internal */ slackRuntimeContextNotice?: string;
  /** @internal */ assistantId?: string;
  /** @internal */ commandIntent?: {
    type: string;
    payload?: string;
    languageCode?: string;
  };
  /** @internal */ surfaceActionRequestIds = new Set<string>();
  /** @internal */ approvedViaPromptThisTurn = false;
  /**
   * When true, side-effect tools must prompt even if a trust/allow rule
   * would auto-allow. Set by non-interactive callers (e.g. non-guardian
   * phone voice) so their auto-deny handler reliably sees a
   * `confirmation_request` event. See ToolSetupContext.forcePromptSideEffects.
   * @internal
   */
  forcePromptSideEffects = false;
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
  /**
   * Pending standalone UI requests keyed by surfaceId.
   * Daemon-driven surfaces that block the caller until user response or timeout.
   * @internal
   */
  pendingStandaloneSurfaces = new Map<
    string,
    {
      resolve: (result: InteractiveUiResult) => void;
      timer: ReturnType<typeof setTimeout>;
      surfaceType: SurfaceType;
    }
  >();
  /**
   * Short-lived tombstone set of recently-completed standalone surface IDs.
   * Prevents late client actions from falling through to the LLM path.
   * @internal
   */
  recentlyCompletedStandaloneSurfaces = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
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
  /** @internal */ clientTimezone?: string;
  public readonly traceEmitter: TraceEmitter;
  /** @internal */ hasSystemPromptOverride: boolean;
  /** @internal */ readonly graphMemory: ConversationGraphMemory;
  /** @internal */ activeContextNodeIds?: string[];
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
  private cacheWarmAbort?: AbortController;

  constructor(
    conversationId: string,
    provider: Provider,
    systemPrompt: string,
    maxTokens: number | undefined,
    sendToClient: (msg: ServerMessage) => void,
    workingDir: string,
    sharedCesClient?: CesClient,
    speedOverride?: Speed,
    cacheTtl?: "5m" | "1h",
    modelOverride?: string,
  ) {
    this.conversationId = conversationId;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.graphMemory = new ConversationGraphMemory(conversationId);
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
    this.secretPrompter = new SecretPrompter();

    // Register call notifiers (reads ctx properties lazily)
    registerConversationNotifiers(conversationId, this);

    // Tool infrastructure
    this.executor = new ToolExecutor(this.prompter);
    this.profiler = new ToolProfiler();
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolTraceListener(this.eventBus, this.traceEmitter);
    registerToolProfilingListener(this.eventBus, this.profiler);
    registerToolPermissionTelemetryListener(this.eventBus);
    const auditToolLifecycleEvent = createToolAuditListener();
    const publishToolDomainEvent = createToolDomainEventPublisher(
      this.eventBus,
    );
    const handleToolLifecycleEvent = (event: ToolLifecycleEvent) => {
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
    );

    const config = getConfig();
    this.streamThinking = config.llm.default.thinking.streamThinking ?? false;

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

    // If an explicit modelOverride is supplied, use it verbatim. Otherwise
    // leave the model unset and let `RetryProvider`'s call-site resolver pick
    // it up from `llm.default` / `llm.callSites.<id>` on every turn.
    const resolvedModel: string | undefined = modelOverride;

    const resolveSystemPromptCallback = (
      _history: Message[],
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
      };
      if (configuredMaxTokens !== undefined) {
        resolved.maxTokens = configuredMaxTokens;
      }
      if (resolvedModel !== undefined) {
        resolved.model = resolvedModel;
      }
      return resolved;
    };

    const fastModeEnabled = isAssistantFeatureFlagEnabled("fast-mode", config);
    const resolvedSpeed = speedOverride ?? config.llm.default.speed;
    const llmDefault = config.llm.default;
    const initialContextWindow = resolveEffectiveContextWindow({
      llm: config.llm,
      callSite: "mainAgent",
    });
    const initialContextWindowConfig = contextWindowConfigFromEffective(
      llmDefault.contextWindow,
      initialContextWindow,
    );

    const agentLoopConfig: Partial<AgentLoopConfig> = {
      thinking: llmDefault.thinking,
      effort: llmDefault.effort,
      ...(fastModeEnabled && resolvedSpeed === "fast"
        ? { speed: resolvedSpeed }
        : {}),
      ...(cacheTtl ? { cacheTtl } : {}),
    };
    if (configuredMaxTokens !== undefined) {
      agentLoopConfig.maxTokens = configuredMaxTokens;
    }

    this.agentLoop = new AgentLoop(
      provider,
      systemPrompt,
      agentLoopConfig,
      toolDefs.length > 0 ? toolDefs : undefined,
      toolDefs.length > 0 ? toolExecutor : undefined,
      resolveTools,
      resolveSystemPromptCallback,
    );
    this.contextWindowManager = new ContextWindowManager({
      provider,
      systemPrompt: () => resolveSystemPromptCallback([]).systemPrompt,
      config: initialContextWindowConfig,
      toolTokenBudget: this.agentLoop.getToolTokenBudget(),
    });
  }

  // ── Onboarding context ───────────────────────────────────────────

  setOnboardingContext(ctx: OnboardingContext): void {
    this.onboardingContext = ctx;
  }

  getOnboardingContext(): OnboardingContext | undefined {
    return this.onboardingContext;
  }

  // ── Prompt Cache Warming ─────────────────────────────────────────

  /**
   * Fire-and-forget LLM call with max_tokens=1 to populate the provider's
   * prompt cache (system prompt + tools). Called after the canned first
   * greeting so the user's next real message gets a cache hit.
   */
  warmPromptCache(): void {
    this.cacheWarmAbort?.abort();
    const abort = new AbortController();
    this.cacheWarmAbort = abort;

    const systemPrompt = this.hasSystemPromptOverride
      ? this.systemPrompt
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
        })();
    const tools = buildToolDefinitions();
    const provider = this.provider;

    const warmMessage: Message = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };

    provider
      .sendMessage([warmMessage], tools, systemPrompt, {
        config: {
          max_tokens: 1,
          callSite: "mainAgent",
          usageTracking: "manual",
        },
        signal: abort.signal,
      })
      .then(() => {
        log.info("Prompt cache warmed successfully");
      })
      .catch((err) => {
        if (!abort.signal.aborted) {
          log.warn({ err }, "Prompt cache warming failed (non-fatal)");
        }
      })
      .finally(() => {
        if (this.cacheWarmAbort === abort) {
          this.cacheWarmAbort = undefined;
        }
      });
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
  ): void {
    this.sendToClient = sendToClient;
    this.hasNoClient = hasNoClient;
    this.prompter.updateSender(sendToClient);
    this.traceEmitter.updateSender(sendToClient);

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
    // Cancel all pending standalone surfaces so callers get a clean
    // cancellation instead of hanging forever. Emit dismiss notifications
    // to the client so surfaces don't remain visually active if the client
    // reconnects after dispose.
    for (const [surfaceId, entry] of this.pendingStandaloneSurfaces) {
      clearTimeout(entry.timer);
      try {
        broadcastMessage({
          type: "ui_surface_dismiss",
          conversationId: this.conversationId,
          surfaceId,
        });
      } catch {
        // Best-effort: the client may already be disconnected during dispose.
      }
      entry.resolve({
        status: "cancelled",
        surfaceId,
        cancellationReason: "resolver_unavailable",
      });
    }
    this.pendingStandaloneSurfaces.clear();
    // Clear tombstone timers to prevent dangling references after dispose.
    for (const timer of this.recentlyCompletedStandaloneSurfaces.values()) {
      clearTimeout(timer);
    }
    this.recentlyCompletedStandaloneSurfaces.clear();
    // Flush any pending debounced surface-data persists for this
    // conversation so updates that arrived inside the debounce window
    // still land in the DB before teardown. Flushing also clears the
    // pending entries, so no separate cancel call is needed.
    flushPendingSurfaceDataPersists(this.conversationId);
    // Only dispose the per-conversation CU and app-control proxies.
    // Bash/File/Transfer are singletons — their lifecycle is managed by
    // static disposeInstance().
    this.hostCuProxy?.dispose();
    this.hostAppControlProxy?.dispose();
    this.hostAppControlProxy = undefined;
    // CES client is owned by DaemonServer — just drop the reference.
    // Do NOT close it here; the server manages the CES lifecycle.
    this.cesClient = undefined;
    this.activeContextNodeIds = this.graphMemory.tracker.getActiveNodeIds();
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
    onEvent?: (msg: ServerMessage) => void,
    requestId?: string,
    activeSurfaceId?: string,
    currentPage?: string,
    metadata?: Record<string, unknown>,
    options?: { isInteractive?: boolean },
    displayContent?: string,
    transport?: ConversationTransportMetadata,
    clientMessageId?: string,
  ): { queued: boolean; requestId: string; rejected?: boolean } {
    return enqueueMessageImpl(
      this,
      content,
      attachments,
      onEvent ?? this.sendToClient,
      requestId ?? crypto.randomUUID(),
      activeSurfaceId,
      currentPage,
      metadata,
      options,
      displayContent,
      transport,
      clientMessageId,
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

    const effectiveDecision = decision;

    // Capture toolUseId before resolving (resolution deletes the pending entry)
    const toolUseId = this.prompter.getToolUseId(requestId);

    this.prompter.resolveConfirmation(
      requestId,
      effectiveDecision,
      selectedPattern,
      selectedScope,
      decisionContext,
    );

    // Emit authoritative confirmation state and activity transition centrally
    // so ALL callers (HTTP handlers, /v1/confirm, channel bridges) get
    // consistent events without duplicating emission logic.
    const resolvedState =
      effectiveDecision === "deny"
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
  }

  handleSecretResponse(
    requestId: string,
    value?: string,
    delivery?: "store" | "transient_send",
  ): void {
    this.secretPrompter.resolveSecret(requestId, value, delivery);
  }

  setHostCuProxy(proxy: HostCuProxy | undefined): void {
    if (this.hostCuProxy && this.hostCuProxy !== proxy) {
      this.hostCuProxy.dispose();
    }
    this.hostCuProxy = proxy;
  }

  setHostAppControlProxy(proxy: HostAppControlProxy | undefined): void {
    if (this.hostAppControlProxy && this.hostAppControlProxy !== proxy) {
      this.hostAppControlProxy.dispose();
    }
    this.hostAppControlProxy = proxy;
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

  async forceCompact(options?: {
    targetInputTokensOverride?: number;
  }): Promise<ContextWindowResult> {
    const conversationRow = getConversation(this.conversationId);
    const overrideProfile =
      getConversationOverrideProfileFromRow(conversationRow) ?? null;
    const config = getConfig();
    const effectiveContextWindow = resolveEffectiveContextWindow({
      llm: config.llm,
      callSite: "mainAgent",
      overrideProfile: overrideProfile ?? undefined,
    });
    (
      this.contextWindowManager as ContextWindowManager & {
        updateConfig?: (config: ContextWindowConfig) => void;
      }
    ).updateConfig?.(
      contextWindowConfigFromEffective(
        config.llm.default.contextWindow,
        effectiveContextWindow,
      ),
    );
    const slackChronologicalContext =
      this.channelCapabilities?.channel === "slack"
        ? loadSlackChronologicalContext(
            this.conversationId,
            this.channelCapabilities,
            {
              trustClass: this.trustContext?.trustClass,
              contextSummary: conversationRow?.contextSummary,
              contextCompactedMessageCount:
                conversationRow?.contextCompactedMessageCount,
              slackContextCompactionWatermarkTs:
                conversationRow?.slackContextCompactionWatermarkTs,
            },
          )
        : null;
    const messagesToCompact =
      slackChronologicalContext?.messages ?? this.messages;
    const result = await this.contextWindowManager.maybeCompact(
      messagesToCompact,
      this.abortController?.signal ?? undefined,
      {
        force: true,
        lastCompactedAt: this.contextCompactedAt ?? undefined,
        conversationOriginChannel:
          getConversationOriginChannel(this.conversationId) ?? undefined,
        overrideProfile,
        targetInputTokensOverride: options?.targetInputTokensOverride,
      },
    );
    // Track circuit-breaker state for user-initiated `/compact` and other
    // forced paths so a successful forced compaction clears a stuck counter
    // and a run of forced failures still trips the breaker. `summaryFailed`
    // is `undefined` on early-return paths (no eligible messages, disabled,
    // etc.) — skip those so they don't silently reset the counter.
    if (result.summaryFailed !== undefined) {
      await trackCompactionOutcome(
        this,
        result.summaryFailed,
        this.sendToClient,
      );
    }
    if (result.compacted) {
      await applyCompactionResult(this, result, this.sendToClient, null, {
        slackContextCompactionWatermarkTs: getSlackCompactionWatermarkForPrefix(
          slackChronologicalContext,
          result.compactedMessages,
        ),
      });
    }
    return result;
  }

  setChannelCapabilities(caps: ChannelCapabilities | null): void {
    this.channelCapabilities = caps ?? undefined;
    this.secretPrompter.setChannelContext(
      caps
        ? {
            channel: caps.channel,
            supportsDynamicUi: caps.supportsDynamicUi,
          }
        : undefined,
    );
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

  setSlackRuntimeContextNotice(notice: string | undefined): void {
    this.slackRuntimeContextNotice = notice;
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

  applyClientTimezoneFromTransport(
    transport: ConversationTransportMetadata,
  ): void {
    this.clientTimezone =
      canonicalizeTimeZone(transport.clientTimezone) ?? undefined;
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
    onEvent?: (msg: ServerMessage) => void,
    options?: {
      isInteractive?: boolean;
      isUserMessage?: boolean;
      titleText?: string;
      callSite?: LLMCallSite;
      /**
       * Optional ad-hoc inference-profile override applied to every LLM call
       * the loop issues for this turn. Forwarded into
       * {@link runAgentLoopImpl} and threaded through to
       * {@link AgentLoop.run} so each provider call carries
       * `config.overrideProfile`. Subagents spawned during the turn inherit
       * this value via {@link SubagentManager.spawn}.
       */
      overrideProfile?: string;
    },
  ): Promise<void> {
    return runAgentLoopImpl(
      this,
      content,
      userMessageId,
      onEvent ?? this.sendToClient,
      options,
    );
  }

  drainQueue(reason: QueueDrainReason = "loop_complete"): Promise<void> {
    return drainQueueImpl(this as ProcessConversationContext, reason);
  }

  async processMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent?: (msg: ServerMessage) => void,
    requestId?: string,
    activeSurfaceId?: string,
    currentPage?: string,
    options?: { isInteractive?: boolean; callSite?: LLMCallSite },
    displayContent?: string,
  ): Promise<string> {
    this.cacheWarmAbort?.abort();
    this.cacheWarmAbort = undefined;
    return processMessageImpl(
      this as ProcessConversationContext,
      content,
      attachments,
      onEvent ?? this.sendToClient,
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
