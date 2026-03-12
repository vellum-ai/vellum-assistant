/**
 * Session — thin coordinator that delegates to extracted modules.
 *
 * Each concern lives in its own file:
 * - session-lifecycle.ts    — loadFromDb, abort, dispose
 * - session-messaging.ts    — enqueueMessage, persistUserMessage, redirectToSecurePrompt
 * - session-agent-loop.ts   — runAgentLoop, generateTitle
 * - session-notifiers.ts    — watch/call notifier registration
 * - session-tool-setup.ts   — tool definitions, executor, resolveTools callback
 * - session-media-retry.ts  — media trimming + raceWithTimeout
 * - session-process.ts      — drainQueue, processMessage
 * - session-history.ts      — undo, regenerate, consolidateAssistantMessages
 * - session-surfaces.ts     — handleSurfaceAction, handleSurfaceUndo
 * - session-workspace.ts    — refreshWorkspaceTopLevelContext
 * - session-usage.ts        — recordUsage
 */

import type { ResolvedSystemPrompt } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { ContextWindowManager } from "../context/window-manager.js";
import { EventBus } from "../events/bus.js";
import type { AssistantDomainEvents } from "../events/domain-events.js";
import { createToolAuditListener } from "../events/tool-audit-listener.js";
import { createToolDomainEventPublisher } from "../events/tool-domain-event-publisher.js";
import { registerToolMetricsLoggingListener } from "../events/tool-metrics-listener.js";
import { registerToolNotificationListener } from "../events/tool-notification-listener.js";
import {
  registerToolProfilingListener,
  ToolProfiler,
} from "../events/tool-profiling-listener.js";
import { registerToolTraceListener } from "../events/tool-trace-listener.js";
import { getHookManager } from "../hooks/manager.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { SecretPrompter } from "../permissions/secret-prompter.js";
import type { UserDecision } from "../permissions/types.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import type { Message } from "../providers/types.js";
import type { Provider } from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import type { AuthContext } from "../runtime/auth/types.js";
import * as approvalOverrides from "../runtime/session-approval-overrides.js";
import { ToolExecutor } from "../tools/executor.js";
import type { AssistantAttachmentDraft } from "./assistant-attachments.js";
import { HostBashProxy } from "./host-bash-proxy.js";
import { HostFileProxy } from "./host-file-proxy.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UsageStats,
  UserMessageAttachment,
} from "./message-protocol.js";
import type {
  AssistantActivityState,
  ConfirmationStateChanged,
} from "./message-types/messages.js";
import { runAgentLoopImpl } from "./session-agent-loop.js";
import { ConflictGate } from "./session-conflict-gate.js";
import type { HistorySessionContext } from "./session-history.js";
import {
  regenerate as regenerateImpl,
  undo as undoImpl,
} from "./session-history.js";
import {
  abortSession,
  disposeSession,
  loadFromDb as loadFromDbImpl,
} from "./session-lifecycle.js";
import type { RedirectToSecurePromptOptions } from "./session-messaging.js";
import {
  enqueueMessage as enqueueMessageImpl,
  persistUserMessage as persistUserMessageImpl,
  redirectToSecurePrompt as redirectToSecurePromptImpl,
} from "./session-messaging.js";
// Extracted modules
import { registerSessionNotifiers } from "./session-notifiers.js";
import type { ProcessSessionContext } from "./session-process.js";
import {
  drainQueue as drainQueueImpl,
  processMessage as processMessageImpl,
} from "./session-process.js";
import type { QueueDrainReason } from "./session-queue-manager.js";
import { MessageQueue } from "./session-queue-manager.js";
import type {
  ChannelCapabilities,
  TrustContext,
} from "./session-runtime-assembly.js";
import { messagesContainAttachments } from "./session-runtime-assembly.js";
import type { SkillProjectionCache } from "./session-skill-tools.js";
import {
  createSurfaceMutex,
  handleSurfaceAction as handleSurfaceActionImpl,
  handleSurfaceUndo as handleSurfaceUndoImpl,
} from "./session-surfaces.js";
import type { ToolSetupContext } from "./session-tool-setup.js";
import {
  buildToolDefinitions,
  createResolveToolsCallback,
  createToolExecutor,
} from "./session-tool-setup.js";
import { refreshWorkspaceTopLevelContextIfNeeded as refreshWorkspaceImpl } from "./session-workspace.js";
import { TraceEmitter } from "./trace-emitter.js";

export interface SessionMemoryPolicy {
  scopeId: string;
  includeDefaultFallback: boolean;
  strictSideEffects: boolean;
}

export const DEFAULT_MEMORY_POLICY: Readonly<SessionMemoryPolicy> =
  Object.freeze({
    scopeId: "default",
    includeDefaultFallback: false,
    strictSideEffects: false,
  });

export { findLastUndoableUserMessageIndex } from "./session-history.js";
export type { QueueDrainReason, QueuePolicy } from "./session-queue-manager.js";

export class Session {
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
  /** @internal */ sandboxOverride?: boolean;
  /** @internal */ allowedToolNames?: Set<string>;
  /** @internal */ toolsDisabledDepth = 0;
  /** @internal */ preactivatedSkillIds?: string[];
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
  /** @internal */ currentRequestId?: string;
  /** @internal */ conflictGate = new ConflictGate();
  /** @internal */ hasNoClient = false;
  /** @internal */ hasAttachments = false;
  /** @internal */ headlessLock = false;
  /** @internal */ taskRunId?: string;
  /** @internal */ callSessionId?: string;
  /** @internal */ hostBashProxy?: HostBashProxy;
  /** @internal */ hostFileProxy?: HostFileProxy;
  /** @internal */ readonly queue = new MessageQueue();
  /** @internal */ currentActiveSurfaceId?: string;
  /** @internal */ currentPage?: string;
  /** @internal */ channelCapabilities?: ChannelCapabilities;
  /** @internal */ trustContext?: TrustContext;
  /** @internal */ authContext?: AuthContext;
  /** @internal */ loadedHistoryTrustClass?: TrustClass;
  /** @internal */ voiceCallControlPrompt?: string;
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
    { surfaceType: SurfaceType; data: SurfaceData; title?: string }
  >();
  /** @internal */ surfaceUndoStacks = new Map<string, string[]>();
  /** @internal */ withSurface = createSurfaceMutex();
  /** @internal */ currentTurnSurfaces: Array<{
    surfaceId: string;
    surfaceType: SurfaceType;
    title?: string;
    data: SurfaceData;
    actions?: Array<{ id: string; label: string; style?: string }>;
    display?: string;
  }> = [];
  /** @internal */ onEscalateToComputerUse?: (
    task: string,
    sourceSessionId: string,
  ) => boolean;
  /** @internal */ workspaceTopLevelContext: string | null = null;
  /** @internal */ workspaceTopLevelDirty = true;
  public readonly traceEmitter: TraceEmitter;
  public memoryPolicy: SessionMemoryPolicy;
  /** @internal */ streamThinking: boolean;
  /** @internal */ turnCount = 0;
  public lastAssistantAttachments: AssistantAttachmentDraft[] = [];
  public lastAttachmentWarnings: string[] = [];
  /** @internal */ currentTurnChannelContext: TurnChannelContext | null = null;
  /** @internal */ currentTurnInterfaceContext: TurnInterfaceContext | null =
    null;
  /** @internal */ activityVersion = 0;
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
    memoryPolicy?: SessionMemoryPolicy,
  ) {
    this.conversationId = conversationId;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.memoryPolicy = memoryPolicy
      ? { ...memoryPolicy }
      : { ...DEFAULT_MEMORY_POLICY };
    this.traceEmitter = new TraceEmitter(conversationId, sendToClient);
    this.prompter = new PermissionPrompter(sendToClient);
    this.prompter.setOnStateChanged((requestId, state, source, toolUseId) => {
      // Route through emitConfirmationStateChanged so the event reaches
      // the client via sendToClient (wired to the SSE hub for HTTP sessions).
      this.emitConfirmationStateChanged({
        sessionId: this.conversationId,
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
    registerSessionNotifiers(conversationId, this);

    // Tool infrastructure
    this.executor = new ToolExecutor(this.prompter);
    this.profiler = new ToolProfiler();
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolNotificationListener(this.eventBus, (msg) =>
      this.sendToClient(msg),
    );
    registerToolTraceListener(this.eventBus, this.traceEmitter);
    registerToolProfilingListener(this.eventBus, this.profiler);
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
    const resolveTools = createResolveToolsCallback(toolDefs, this);

    const configuredMaxTokens = maxTokens;
    // When a systemPromptOverride was provided, use it as-is; otherwise
    // rebuild the full prompt each turn (picks up any workspace file changes).
    const hasSystemPromptOverride = systemPrompt !== buildSystemPrompt();

    const resolveSystemPromptCallback = (
      _history: import("../providers/types.js").Message[],
    ): ResolvedSystemPrompt => {
      const resolved = {
        systemPrompt: hasSystemPromptOverride
          ? systemPrompt
          : buildSystemPrompt({ hasNoClient: this.hasNoClient }),
        maxTokens: configuredMaxTokens,
      };
      return resolved;
    };

    this.agentLoop = new AgentLoop(
      provider,
      systemPrompt,
      {
        maxTokens,
        maxInputTokens: config.contextWindow.maxInputTokens,
        thinking: config.thinking,
        effort: config.effort,
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
    });

    void getHookManager().trigger("session-start", {
      sessionId: this.conversationId,
      workingDir: this.workingDir,
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async loadFromDb(): Promise<void> {
    await loadFromDbImpl(this);
    // Scan loaded history for attachment content blocks so that asset
    // tools are available when resuming a conversation that already had
    // attachments. One-way: once true it stays true for the session.
    // Also picks up the hasAttachments flag set by loadFromDbImpl which
    // scans compacted (sliced-off) messages that aren't in this.messages.
    if (!this.hasAttachments && messagesContainAttachments(this.messages)) {
      this.hasAttachments = true;
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
      this.hostFileProxy?.updateSender(sendToClient, !hasNoClient);
    }
  }

  /** Returns the current sendToClient reference for identity comparison. */
  getCurrentSender(): (msg: ServerMessage) => void {
    return this.sendToClient;
  }

  /** Mark host proxies as unavailable so tool execution uses local fallback. */
  clearProxyAvailability(): void {
    this.hostBashProxy?.updateSender(this.sendToClient, false);
    this.hostFileProxy?.updateSender(this.sendToClient, false);
  }

  /** Restore host proxy availability based on whether a real client is connected. */
  restoreProxyAvailability(): void {
    if (!this.hasNoClient) {
      this.hostBashProxy?.updateSender(this.sendToClient, true);
      this.hostFileProxy?.updateSender(this.sendToClient, true);
    }
  }

  setSandboxOverride(enabled: boolean | undefined): void {
    this.sandboxOverride = enabled;
  }

  setEscalationHandler(
    handler: (task: string, sourceSessionId: string) => boolean,
  ): void {
    this.onEscalateToComputerUse = handler;
  }

  hasEscalationHandler(): boolean {
    return this.onEscalateToComputerUse !== undefined;
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

  abort(): void {
    abortSession(this);
  }

  dispose(): void {
    approvalOverrides.clearMode(this.conversationId);
    this.hostBashProxy?.dispose();
    this.hostFileProxy?.dispose();
    disposeSession(this);
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

    // Capture toolUseId before resolving (resolution deletes the pending entry)
    const toolUseId = this.prompter.getToolUseId(requestId);

    this.prompter.resolveConfirmation(
      requestId,
      decision,
      selectedPattern,
      selectedScope,
      decisionContext,
    );

    // Mode activation (setTimedMode / setThreadMode) is intentionally NOT
    // done here. It is handled in permission-checker.ts where the
    // guardian trust-class and conversation context are available.

    // Emit authoritative confirmation state and activity transition centrally
    // so ALL callers (HTTP handlers, /v1/confirm, channel bridges) get
    // consistent events without duplicating emission logic.
    const resolvedState =
      decision === "deny" || decision === "always_deny"
        ? ("denied" as const)
        : ("approved" as const);
    this.emitConfirmationStateChanged({
      sessionId: this.conversationId,
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

  resolveHostFile(
    requestId: string,
    response: { content: string; isError: boolean },
  ): void {
    this.hostFileProxy?.resolve(requestId, response);
  }

  setHostFileProxy(proxy: HostFileProxy | undefined): void {
    if (this.hostFileProxy && this.hostFileProxy !== proxy) {
      this.hostFileProxy.dispose();
    }
    this.hostFileProxy = proxy;
  }

  // ── Server-authoritative state signals ─────────────────────────────

  emitConfirmationStateChanged(
    params: Omit<ConfirmationStateChanged, "type">,
  ): void {
    const msg: ServerMessage = {
      type: "confirmation_state_changed",
      ...params,
    } as ServerMessage;
    this.sendToClient(msg);
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
      sessionId: this.conversationId,
      activityVersion: this.activityVersion,
      phase,
      anchor,
      requestId,
      reason,
      ...(statusText ? { statusText } : {}),
    } as ServerMessage;
    this.sendToClient(msg);
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
    // One-way flag: once an attachment arrives, asset tools stay available
    // for the remainder of the session.
    if (!this.hasAttachments && attachments.length > 0) {
      this.hasAttachments = true;
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
    return drainQueueImpl(this as ProcessSessionContext, reason);
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
      this as ProcessSessionContext,
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
    return undoImpl(this as HistorySessionContext);
  }

  async regenerate(
    onEvent: (msg: ServerMessage) => void,
    requestId?: string,
  ): Promise<void> {
    return regenerateImpl(this as HistorySessionContext, onEvent, requestId);
  }

  // ── Surfaces ─────────────────────────────────────────────────────

  handleSurfaceAction(
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ): void {
    handleSurfaceActionImpl(this, surfaceId, actionId, data);
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
