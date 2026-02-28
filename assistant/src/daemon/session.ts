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

import { AgentLoop, type ResolvedSystemPrompt } from '../agent/loop.js';
import type { TurnChannelContext, TurnInterfaceContext } from '../channels/types.js';
import { getConfig } from '../config/loader.js';
import { buildSystemPrompt } from '../config/system-prompt.js';
import { ContextWindowManager } from '../context/window-manager.js';
import { EventBus } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
import { createToolAuditListener } from '../events/tool-audit-listener.js';
import { createToolDomainEventPublisher } from '../events/tool-domain-event-publisher.js';
import { registerToolMetricsLoggingListener } from '../events/tool-metrics-listener.js';
import { registerToolNotificationListener } from '../events/tool-notification-listener.js';
import { registerToolProfilingListener,ToolProfiler } from '../events/tool-profiling-listener.js';
import { registerToolTraceListener } from '../events/tool-trace-listener.js';
import { getHookManager } from '../hooks/manager.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { SecretPrompter } from '../permissions/secret-prompter.js';
import type { UserDecision } from '../permissions/types.js';
import type { Message } from '../providers/types.js';
import type { Provider } from '../providers/types.js';
import { ToolExecutor } from '../tools/executor.js';
import type { AssistantAttachmentDraft } from './assistant-attachments.js';
import type { ServerMessage, SurfaceData,SurfaceType, UsageStats, UserMessageAttachment } from './ipc-protocol.js';
import {
  classifyResponseTierAsync,
  classifyResponseTierDetailed,
  resolveWithHint,
  type SessionTierHint,
  tierMaxTokens,
  tierModel,
} from './response-tier.js';
import { runAgentLoopImpl } from './session-agent-loop.js';
import { ConflictGate } from './session-conflict-gate.js';
import {
  type HistorySessionContext,
  regenerate as regenerateImpl,
  undo as undoImpl,
} from './session-history.js';
import {
  abortSession,
  disposeSession,
  loadFromDb as loadFromDbImpl,
} from './session-lifecycle.js';
import {
  enqueueMessage as enqueueMessageImpl,
  persistUserMessage as persistUserMessageImpl,
  redirectToSecurePrompt as redirectToSecurePromptImpl,
  type RedirectToSecurePromptOptions,
} from './session-messaging.js';
// Extracted modules
import { registerSessionNotifiers } from './session-notifiers.js';
import {
  drainQueue as drainQueueImpl,
  processMessage as processMessageImpl,
  type ProcessSessionContext,
} from './session-process.js';
import type { QueueDrainReason, QueueMetrics } from './session-queue-manager.js';
import { MessageQueue } from './session-queue-manager.js';
import type { ChannelCapabilities, GuardianRuntimeContext } from './session-runtime-assembly.js';
import type { SkillProjectionCache } from './session-skill-tools.js';
import {
  createSurfaceMutex,
  handleSurfaceAction as handleSurfaceActionImpl,
  handleSurfaceUndo as handleSurfaceUndoImpl,
} from './session-surfaces.js';
import {
  buildToolDefinitions,
  createResolveToolsCallback,
  createToolExecutor,
  type ToolSetupContext,
} from './session-tool-setup.js';
import { refreshWorkspaceTopLevelContextIfNeeded as refreshWorkspaceImpl } from './session-workspace.js';
import { TraceEmitter } from './trace-emitter.js';

export interface SessionMemoryPolicy {
  scopeId: string;
  includeDefaultFallback: boolean;
  strictSideEffects: boolean;
}

export const DEFAULT_MEMORY_POLICY: Readonly<SessionMemoryPolicy> = Object.freeze({
  scopeId: 'default',
  includeDefaultFallback: false,
  strictSideEffects: false,
});

export { findLastUndoableUserMessageIndex } from './session-history.js';
export { MAX_QUEUE_DEPTH, type QueueDrainReason, type QueuePolicy } from './session-queue-manager.js';

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
  /** @internal */ preactivatedSkillIds?: string[];
  /** @internal */ coreToolNames: Set<string>;
  /** @internal */ readonly skillProjectionState = new Map<string, string>();
  /** @internal */ readonly skillProjectionCache: SkillProjectionCache = {};
  /** @internal */ usageStats: UsageStats = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  /** @internal */ readonly systemPrompt: string;
  /** @internal */ contextWindowManager: ContextWindowManager;
  /** @internal */ contextCompactedMessageCount = 0;
  /** @internal */ contextCompactedAt: number | null = null;
  /** @internal */ currentRequestId?: string;
  /** @internal */ conflictGate = new ConflictGate();
  /** @internal */ hasNoClient = false;
  /** @internal */ headlessLock = false;
  /** @internal */ taskRunId?: string;
  /** @internal */ callSessionId?: string;
  /** @internal */ readonly queue = new MessageQueue();
  /** @internal */ currentActiveSurfaceId?: string;
  /** @internal */ currentPage?: string;
  /** @internal */ channelCapabilities?: ChannelCapabilities;
  /** @internal */ guardianContext?: GuardianRuntimeContext;
  /** @internal */ loadedHistoryTrustClass?: GuardianRuntimeContext['trustClass'];
  /** @internal */ voiceCallControlPrompt?: string;
  /** @internal */ assistantId?: string;
  /** @internal */ commandIntent?: { type: string; payload?: string; languageCode?: string };
  /** @internal */ pendingSurfaceActions = new Map<string, { surfaceType: SurfaceType }>();
  /** @internal */ lastSurfaceAction = new Map<string, { actionId: string; data?: Record<string, unknown> }>();
  /** @internal */ surfaceState = new Map<string, { surfaceType: SurfaceType; data: SurfaceData }>();
  /** @internal */ surfaceUndoStacks = new Map<string, string[]>();
  /** @internal */ withSurface = createSurfaceMutex();
  /** @internal */ currentTurnSurfaces: Array<{ surfaceId: string; surfaceType: SurfaceType; title?: string; data: SurfaceData; actions?: Array<{ id: string; label: string; style?: string }>; display?: string }> = [];
  /** @internal */ onEscalateToComputerUse?: (task: string, sourceSessionId: string) => boolean;
  /** @internal */ workspaceTopLevelContext: string | null = null;
  /** @internal */ workspaceTopLevelDirty = true;
  public readonly traceEmitter: TraceEmitter;
  public memoryPolicy: SessionMemoryPolicy;
  /** @internal */ streamThinking: boolean;
  /** @internal */ turnCount = 0;
  public lastAssistantAttachments: AssistantAttachmentDraft[] = [];
  public lastAttachmentWarnings: string[] = [];
  /** @internal */ currentTurnChannelContext: TurnChannelContext | null = null;
  /** @internal */ currentTurnInterfaceContext: TurnInterfaceContext | null = null;

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
    this.memoryPolicy = memoryPolicy ? { ...memoryPolicy } : { ...DEFAULT_MEMORY_POLICY };
    this.traceEmitter = new TraceEmitter(conversationId, sendToClient);
    this.prompter = new PermissionPrompter(sendToClient);
    this.secretPrompter = new SecretPrompter(sendToClient);

    // Register watch/call notifiers (reads ctx properties lazily)
    registerSessionNotifiers(conversationId, this);

    // Tool infrastructure
    this.executor = new ToolExecutor(this.prompter);
    this.profiler = new ToolProfiler();
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolNotificationListener(this.eventBus, (msg) => this.sendToClient(msg));
    registerToolTraceListener(this.eventBus, this.traceEmitter);
    registerToolProfilingListener(this.eventBus, this.profiler);
    const auditToolLifecycleEvent = createToolAuditListener();
    const publishToolDomainEvent = createToolDomainEventPublisher(this.eventBus);
    const handleToolLifecycleEvent = (event: import('../tools/types.js').ToolLifecycleEvent) => {
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
    // When a systemPromptOverride was provided, skip tier-based prompt
    // rebuilding and use the override as-is — only scale maxTokens and model.
    const hasSystemPromptOverride = systemPrompt !== buildSystemPrompt();

    // Known runtime-injected XML context block prefixes. Using an explicit
    // list avoids false-positives on user messages that start with HTML/XML.
    const INJECTED_PREFIXES = [
      '<channel_capabilities>',
      '<channel_command_context>',
      '<channel_turn_context>',
      '<temporal_context>',
      '<guardian_context>',
      '<inbound_actor_context>',
      '<voice_call_control>',
      '<workspace_top_level>',
      '<active_workspace>',
      '<active_dynamic_page>',
      '<dynamic-profile-context>',
      '<memory_recall',
      '<memory source=',
      '<memory',
      '<system_notice>',
      '<interface_turn_context>',
    ];

    // Track the last user-message tier so tool-use continuation turns
    // (where user text is empty — only tool_result blocks) inherit it
    // instead of falling to 'low'.
    let lastUserMessageTier: import('./response-tier.js').ResponseTier = 'high';
    let sessionTierHint: SessionTierHint | null = null;
    const recentUserTexts: string[] = []; // circular buffer, max 3
    const MAX_RECENT_TEXTS = 3;

    const resolveSystemPromptCallback = (history: import('../providers/types.js').Message[]): ResolvedSystemPrompt => {
      // Extract last user message text, ignoring runtime-injected context blocks
      const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
      let userText = '';
      let isToolResultOnly = false;
      if (lastUserMsg) {
        const _hasToolResult = lastUserMsg.content.some((b) => b.type === 'tool_result');
        for (const block of lastUserMsg.content) {
          if (block.type === 'text') {
            const trimmed = block.text.trimStart();
            if (!INJECTED_PREFIXES.some((p) => trimmed.startsWith(p))) {
              userText += block.text;
            }
          }
        }
        // Inherit previous tier when there's no real user text — either
        // tool_result-only messages or system nudges where all text was
        // filtered out as injected context.
        isToolResultOnly = userText.trim().length === 0;
      }

      let tier: import('./response-tier.js').ResponseTier;

      if (isToolResultOnly) {
        // Tool-use continuation: inherit previous tier
        tier = lastUserMessageTier;
      } else {
        const classification = classifyResponseTierDetailed(userText, this.turnCount);
        tier = resolveWithHint(classification, sessionTierHint, this.turnCount);
        lastUserMessageTier = tier;

        // Update recent user texts buffer
        const trimmedText = userText.trim();
        if (trimmedText) {
          if (recentUserTexts.length >= MAX_RECENT_TEXTS) {
            recentUserTexts.shift();
          }
          recentUserTexts.push(trimmedText);
        }

        // Fire background Haiku classification when confidence is low
        if (classification.confidence === 'low') {
          void classifyResponseTierAsync([...recentUserTexts]).then((asyncTier) => {
            if (asyncTier) {
              sessionTierHint = {
                tier: asyncTier,
                turn: this.turnCount,
                timestamp: Date.now(),
              };
            }
          });
        }
      }

      const model = tierModel(tier, provider.name);
      return {
        systemPrompt: hasSystemPromptOverride ? systemPrompt : buildSystemPrompt(tier),
        maxTokens: tierMaxTokens(tier, configuredMaxTokens),
        model,
      };
    };

    this.agentLoop = new AgentLoop(
      provider,
      systemPrompt,
      { maxTokens, maxInputTokens: config.contextWindow.maxInputTokens, thinking: config.thinking, maxToolUseTurns: config.maxToolUseTurns },
      toolDefs.length > 0 ? toolDefs : undefined,
      toolDefs.length > 0 ? toolExecutor : undefined,
      resolveTools,
      resolveSystemPromptCallback,
    );
    this.contextWindowManager = new ContextWindowManager(
      provider,
      systemPrompt,
      config.contextWindow,
    );

    void getHookManager().trigger('session-start', {
      sessionId: this.conversationId,
      workingDir: this.workingDir,
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async loadFromDb(): Promise<void> {
    return loadFromDbImpl(this);
  }

  async ensureActorScopedHistory(): Promise<void> {
    const currentTrustClass = this.guardianContext?.trustClass;
    if (this.loadedHistoryTrustClass === currentTrustClass) return;
    await this.loadFromDb();
  }

  updateClient(sendToClient: (msg: ServerMessage) => void, hasNoClient = false): void {
    this.sendToClient = sendToClient;
    this.hasNoClient = hasNoClient;
    this.prompter.updateSender(sendToClient);
    this.secretPrompter.updateSender(sendToClient);
    this.traceEmitter.updateSender(sendToClient);
  }

  /** Returns the current sendToClient reference for identity comparison. */
  getCurrentSender(): (msg: ServerMessage) => void {
    return this.sendToClient;
  }

  setSandboxOverride(enabled: boolean | undefined): void {
    this.sandboxOverride = enabled;
  }

  setEscalationHandler(handler: (task: string, sourceSessionId: string) => boolean): void {
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
    disposeSession(this);
  }

  // ── Messaging ────────────────────────────────────────────────────

  redirectToSecurePrompt(detectedTypes: string[], options?: RedirectToSecurePromptOptions): void {
    redirectToSecurePromptImpl(this.conversationId, this.secretPrompter, detectedTypes, options);
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
  ): { queued: boolean; rejected?: boolean; requestId: string } {
    return enqueueMessageImpl(this, content, attachments, onEvent, requestId, activeSurfaceId, currentPage, metadata, options, displayContent);
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getQueueMetrics(): QueueMetrics {
    return this.queue.getMetrics();
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
  ): void {
    this.prompter.resolveConfirmation(
      requestId,
      decision,
      selectedPattern,
      selectedScope,
      decisionContext,
    );
  }

  handleSecretResponse(requestId: string, value?: string, delivery?: 'store' | 'transient_send'): void {
    this.secretPrompter.resolveSecret(requestId, value, delivery);
  }

  setChannelCapabilities(caps: ChannelCapabilities | null): void {
    this.channelCapabilities = caps ?? undefined;
  }

  setGuardianContext(ctx: GuardianRuntimeContext | null): void {
    this.guardianContext = ctx ?? undefined;
  }

  setVoiceCallControlPrompt(prompt: string | null): void {
    this.voiceCallControlPrompt = prompt ?? undefined;
  }

  setAssistantId(assistantId: string | null): void {
    this.assistantId = assistantId ?? undefined;
  }

  setCommandIntent(intent: { type: string; payload?: string; languageCode?: string } | null): void {
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
    return persistUserMessageImpl(this, content, attachments, requestId, metadata, displayContent);
  }

  // ── Agent Loop ───────────────────────────────────────────────────

  async runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: { skipPreMessageRollback?: boolean; isInteractive?: boolean; titleText?: string },
  ): Promise<void> {
    return runAgentLoopImpl(this, content, userMessageId, onEvent, options);
  }


  drainQueue(reason: QueueDrainReason = 'loop_complete'): Promise<void> {
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
    return processMessageImpl(this as ProcessSessionContext, content, attachments, onEvent, requestId, activeSurfaceId, currentPage, options, displayContent);
  }

  // ── History ──────────────────────────────────────────────────────

  getMessages(): Message[] {
    return this.messages;
  }

  undo(): number {
    return undoImpl(this as HistorySessionContext);
  }

  async regenerate(onEvent: (msg: ServerMessage) => void, requestId?: string): Promise<void> {
    return regenerateImpl(this as HistorySessionContext, onEvent, requestId);
  }

  // ── Surfaces ─────────────────────────────────────────────────────

  handleSurfaceAction(surfaceId: string, actionId: string, data?: Record<string, unknown>): void {
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
