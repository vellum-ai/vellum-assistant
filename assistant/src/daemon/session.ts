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

import type { Message } from '../providers/types.js';
import type { ServerMessage, UsageStats, UserMessageAttachment, SurfaceType, SurfaceData } from './ipc-protocol.js';
import { AgentLoop } from '../agent/loop.js';
import type { Provider } from '../providers/types.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { SecretPrompter } from '../permissions/secret-prompter.js';
import { ToolExecutor } from '../tools/executor.js';
import type { UserDecision } from '../permissions/types.js';
import { getConfig } from '../config/loader.js';
import { TraceEmitter } from './trace-emitter.js';
import { EventBus } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
import { createToolDomainEventPublisher } from '../events/tool-domain-event-publisher.js';
import { registerToolMetricsLoggingListener } from '../events/tool-metrics-listener.js';
import { registerToolNotificationListener } from '../events/tool-notification-listener.js';
import { registerToolTraceListener } from '../events/tool-trace-listener.js';
import { createToolAuditListener } from '../events/tool-audit-listener.js';
import { ToolProfiler, registerToolProfilingListener } from '../events/tool-profiling-listener.js';
import { ContextWindowManager } from '../context/window-manager.js';
import { getHookManager } from '../hooks/manager.js';
import { ConflictGate } from './session-conflict-gate.js';
import { MessageQueue } from './session-queue-manager.js';
import type { QueueDrainReason } from './session-queue-manager.js';
import type { ChannelCapabilities } from './session-runtime-assembly.js';
import type { AssistantAttachmentDraft } from './assistant-attachments.js';
import {
  handleSurfaceAction as handleSurfaceActionImpl,
  handleSurfaceUndo as handleSurfaceUndoImpl,
} from './session-surfaces.js';
import {
  undo as undoImpl,
  regenerate as regenerateImpl,
  type HistorySessionContext,
} from './session-history.js';
import { refreshWorkspaceTopLevelContextIfNeeded as refreshWorkspaceImpl } from './session-workspace.js';
import {
  drainQueue as drainQueueImpl,
  processMessage as processMessageImpl,
  type ProcessSessionContext,
} from './session-process.js';
import {
  buildToolDefinitions,
  createToolExecutor,
  createResolveToolsCallback,
  type ToolSetupContext,
} from './session-tool-setup.js';
import type { SkillProjectionCache } from './session-skill-tools.js';

// Extracted modules
import { registerSessionNotifiers } from './session-notifiers.js';
import {
  loadFromDb as loadFromDbImpl,
  abortSession,
  disposeSession,
} from './session-lifecycle.js';
import {
  enqueueMessage as enqueueMessageImpl,
  persistUserMessage as persistUserMessageImpl,
  redirectToSecurePrompt as redirectToSecurePromptImpl,
} from './session-messaging.js';
import { runAgentLoopImpl } from './session-agent-loop.js';

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

export { MAX_QUEUE_DEPTH, type QueueDrainReason, type QueuePolicy } from './session-queue-manager.js';
export { findLastUndoableUserMessageIndex } from './session-history.js';

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
  /** @internal */ readonly queue = new MessageQueue();
  /** @internal */ currentActiveSurfaceId?: string;
  /** @internal */ currentPage?: string;
  /** @internal */ channelCapabilities?: ChannelCapabilities;
  /** @internal */ pendingSurfaceActions = new Map<string, { surfaceType: SurfaceType }>();
  /** @internal */ lastSurfaceAction = new Map<string, { actionId: string; data?: Record<string, unknown> }>();
  /** @internal */ surfaceState = new Map<string, { surfaceType: SurfaceType; data: SurfaceData }>();
  /** @internal */ surfaceUndoStacks = new Map<string, string[]>();
  /** @internal */ currentTurnSurfaces: Array<{ surfaceId: string; surfaceType: SurfaceType; title?: string; data: SurfaceData; actions?: Array<{ id: string; label: string; style?: string }>; display?: string }> = [];
  /** @internal */ onEscalateToComputerUse?: (task: string, sourceSessionId: string) => boolean;
  /** @internal */ workspaceTopLevelContext: string | null = null;
  /** @internal */ workspaceTopLevelDirty = true;
  public readonly traceEmitter: TraceEmitter;
  public memoryPolicy: SessionMemoryPolicy;
  /** @internal */ turnCount = 0;
  public lastAssistantAttachments: AssistantAttachmentDraft[] = [];
  public lastAttachmentWarnings: string[] = [];

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
    const resolveTools = createResolveToolsCallback(toolDefs, this);

    this.agentLoop = new AgentLoop(
      provider,
      systemPrompt,
      { maxTokens, maxInputTokens: config.contextWindow.maxInputTokens, thinking: config.thinking },
      toolDefs.length > 0 ? toolDefs : undefined,
      toolDefs.length > 0 ? toolExecutor : undefined,
      resolveTools,
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

  updateClient(sendToClient: (msg: ServerMessage) => void, hasNoClient = false): void {
    this.sendToClient = sendToClient;
    this.hasNoClient = hasNoClient;
    this.prompter.updateSender(sendToClient);
    this.secretPrompter.updateSender(sendToClient);
    this.traceEmitter.updateSender(sendToClient);
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

  redirectToSecurePrompt(detectedTypes: string[], onComplete?: () => void): void {
    redirectToSecurePromptImpl(this.conversationId, this.secretPrompter, detectedTypes, onComplete);
  }

  enqueueMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent: (msg: ServerMessage) => void,
    requestId: string,
    activeSurfaceId?: string,
    currentPage?: string,
    metadata?: Record<string, unknown>,
  ): { queued: boolean; rejected?: boolean; requestId: string } {
    return enqueueMessageImpl(this, content, attachments, onEvent, requestId, activeSurfaceId, currentPage, metadata);
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

  hasPendingSecret(requestId: string): boolean {
    return this.secretPrompter.hasPendingRequest(requestId);
  }

  handleConfirmationResponse(
    requestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    selectedScope?: string,
  ): void {
    this.prompter.resolveConfirmation(requestId, decision, selectedPattern, selectedScope);
  }

  handleSecretResponse(requestId: string, value?: string, delivery?: 'store' | 'transient_send'): void {
    this.secretPrompter.resolveSecret(requestId, value, delivery);
  }

  setChannelCapabilities(caps: ChannelCapabilities | null): void {
    this.channelCapabilities = caps ?? undefined;
  }

  persistUserMessage(
    content: string,
    attachments: UserMessageAttachment[],
    requestId?: string,
    metadata?: Record<string, unknown>,
  ): string {
    return persistUserMessageImpl(this, content, attachments, requestId, metadata);
  }

  // ── Agent Loop ───────────────────────────────────────────────────

  async runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: { skipPreMessageRollback?: boolean },
  ): Promise<void> {
    return runAgentLoopImpl(this, content, userMessageId, onEvent, options);
  }


  drainQueue(reason: QueueDrainReason = 'loop_complete'): void {
    drainQueueImpl(this as ProcessSessionContext, reason);
  }

  async processMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent: (msg: ServerMessage) => void,
    requestId?: string,
    activeSurfaceId?: string,
    currentPage?: string,
  ): Promise<string> {
    return processMessageImpl(this as ProcessSessionContext, content, attachments, onEvent, requestId, activeSurfaceId, currentPage);
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
