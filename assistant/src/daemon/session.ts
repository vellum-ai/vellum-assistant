import { v4 as uuid } from 'uuid';
import type { Message, ContentBlock, ImageContent } from '../providers/types.js';
import type { ServerMessage, UsageStats, UserMessageAttachment, SurfaceType, SurfaceData, DynamicPageSurfaceData } from './ipc-protocol.js';
import { repairHistory, deepRepairHistory } from './history-repair.js';
import { AgentLoop } from '../agent/loop.js';
import type { CheckpointDecision } from '../agent/loop.js';
import type { Provider } from '../providers/types.js';
import { createUserMessage, createAssistantMessage } from '../agent/message-types.js';
import * as conversationStore from '../memory/conversation-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { SecretPrompter } from '../permissions/secret-prompter.js';
import { addRule, findHighestPriorityRule } from '../permissions/trust-store.js';
import { generateScopeOptions } from '../permissions/checker.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ToolLifecycleEventHandler } from '../tools/types.js';
import { getAllToolDefinitions } from '../tools/registry.js';
import { allUiSurfaceTools } from '../tools/ui-surface/definitions.js';
import { allAppTools } from '../tools/apps/definitions.js';
import { requestComputerControlTool } from '../tools/computer-use/request-computer-control.js';
import type { UserDecision } from '../permissions/types.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { TraceEmitter } from './trace-emitter.js';
import { classifySessionError, isUserCancellation, buildSessionErrorMessage } from './session-error.js';
import { EventBus } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
import {
  registerWatchStartNotifier,
  unregisterWatchStartNotifier,
  registerWatchCommentaryNotifier,
  unregisterWatchCommentaryNotifier,
  registerWatchCompletionNotifier,
  unregisterWatchCompletionNotifier,
  pruneWatchSessions,
} from '../tools/watch/watch-state.js';
import type { WatchSession } from '../tools/watch/watch-state.js';
import { lastCommentaryBySession, lastSummaryBySession } from './watch-handler.js';
import { createToolDomainEventPublisher } from '../events/tool-domain-event-publisher.js';
import { registerToolMetricsLoggingListener } from '../events/tool-metrics-listener.js';
import { registerToolNotificationListener } from '../events/tool-notification-listener.js';
import { registerToolTraceListener } from '../events/tool-trace-listener.js';
import { createToolAuditListener } from '../events/tool-audit-listener.js';
import { ToolProfiler, registerToolProfilingListener } from '../events/tool-profiling-listener.js';
import {
  ContextWindowManager,
  createContextSummaryMessage,
} from '../context/window-manager.js';
import { getHookManager } from '../hooks/manager.js';
import {
  stripMemoryRecallMessages,
} from '../memory/retriever.js';
import { getApp, listAppFiles } from '../memory/app-store.js';
import { ConflictGate } from './session-conflict-gate.js';
import { stripDynamicProfileMessages } from './session-dynamic-profile.js';
import { MessageQueue } from './session-queue-manager.js';
import type { QueueDrainReason } from './session-queue-manager.js';
import {
  applyRuntimeInjections,
  stripActiveSurfaceContext,
  stripWorkspaceTopLevelContext,
} from './session-runtime-assembly.js';
import type {
  ActiveSurfaceContext,
} from './session-runtime-assembly.js';
import {
  cleanAssistantContent,
  drainDirectiveDisplayBuffer,
  type DirectiveRequest,
  type AssistantAttachmentDraft,
} from './assistant-attachments.js';
import {
  handleSurfaceAction as handleSurfaceActionImpl,
  handleSurfaceUndo as handleSurfaceUndoImpl,
  refreshSurfacesForApp,
  surfaceProxyResolver,
} from './session-surfaces.js';
import { prepareMemoryContext } from './session-memory.js';
import { updatePublishedAppDeployment } from '../services/published-app-updater.js';
import {
  approveHostAttachmentRead,
  formatAttachmentWarnings,
  resolveAssistantAttachments,
} from './session-attachments.js';
import {
  consolidateAssistantMessages,
  undo as undoImpl,
  regenerate as regenerateImpl,
  type HistorySessionContext,
} from './session-history.js';
import { recordUsage, generateTitle } from './session-usage.js';
import { resolveSlash, isProviderOrderingError } from './session-slash.js';
import { refreshWorkspaceTopLevelContextIfNeeded as refreshWorkspaceImpl } from './session-workspace.js';
import type { UsageActor } from '../usage/actors.js';

const log = getLogger('session');

export { MAX_QUEUE_DEPTH, type QueueDrainReason, type QueuePolicy } from './session-queue-manager.js';
export { findLastUndoableUserMessageIndex } from './session-history.js';

export class Session {
  public readonly conversationId: string;
  private provider: Provider;
  /** @internal — exposed for session-history.ts module functions. */
  messages: Message[] = [];
  private agentLoop: AgentLoop;
  /** @internal — exposed for session-history.ts module functions. */
  processing = false;
  private stale = false;
  /** @internal — exposed for session-history.ts module functions. */
  abortController: AbortController | null = null;
  private prompter: PermissionPrompter;
  private secretPrompter: SecretPrompter;
  private executor: ToolExecutor;
  private profiler: ToolProfiler;
  /** @internal — exposed for session-surfaces.ts module functions. */
  sendToClient: (msg: ServerMessage) => void;
  /** Broadcast a message to all connected sockets (not just this session's client). */
  private broadcastToAllClients?: (msg: ServerMessage) => void;
  private eventBus = new EventBus<AssistantDomainEvents>();
  /** @internal — exposed for session-workspace.ts module functions. */
  workingDir: string;
  private sandboxOverride?: boolean;
  /** @internal — exposed for session-usage.ts module functions. */
  usageStats: UsageStats = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  private readonly systemPrompt: string;
  private contextWindowManager: ContextWindowManager;
  private contextCompactedMessageCount = 0;
  private contextCompactedAt: number | null = null;
  /** @internal — exposed for session-history.ts module functions. */
  currentRequestId?: string;
  /** @internal — exposed for session-usage.ts module functions. */
  assistantId: string | null = null;
  private conflictGate = new ConflictGate();
  private hasNoClient = false;
  private readonly queue = new MessageQueue();
  private currentActiveSurfaceId?: string;
  private currentPage?: string;
  /** @internal — exposed for session-surfaces.ts module functions. */
  pendingSurfaceActions = new Map<string, {
    surfaceType: SurfaceType;
  }>();
  /** @internal */ lastSurfaceAction = new Map<string, { actionId: string; data?: Record<string, unknown> }>();
  /** @internal */ surfaceState = new Map<string, { surfaceType: SurfaceType; data: SurfaceData }>();
  /** @internal Per-surface undo stack: stores previous HTML strings for workspace refinement undo. */
  surfaceUndoStacks = new Map<string, string[]>();
  /** @internal Surfaces created during the current agent loop turn, to be persisted with the message. */
  currentTurnSurfaces: Array<{ surfaceId: string; surfaceType: SurfaceType; title?: string; data: SurfaceData; actions?: Array<{ id: string; label: string; style?: string }>; display?: string }> = [];
  /** @internal */ onEscalateToComputerUse?: (task: string, sourceSessionId: string) => boolean;
  /** @internal — exposed for session-workspace.ts module functions. */
  workspaceTopLevelContext: string | null = null;
  /** @internal — exposed for session-workspace.ts module functions. */
  workspaceTopLevelDirty = true;
  public readonly traceEmitter: TraceEmitter;

  /** Resolved assistant attachment drafts from the most recent exchange. */
  public lastAssistantAttachments: AssistantAttachmentDraft[] = [];
  /** Warnings from directive parsing/resolution for the most recent exchange. */
  public lastAttachmentWarnings: string[] = [];

  constructor(
    conversationId: string,
    provider: Provider,
    systemPrompt: string,
    maxTokens: number,
    sendToClient: (msg: ServerMessage) => void,
    workingDir: string,
    broadcastToAllClients?: (msg: ServerMessage) => void,
  ) {
    this.conversationId = conversationId;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.broadcastToAllClients = broadcastToAllClients;
    this.traceEmitter = new TraceEmitter(conversationId, sendToClient);
    this.prompter = new PermissionPrompter(sendToClient);
    this.secretPrompter = new SecretPrompter(sendToClient);

    registerWatchStartNotifier(conversationId, (session: WatchSession) => {
      this.sendToClient({
        type: 'watch_started',
        sessionId: conversationId,
        watchId: session.watchId,
        durationSeconds: session.durationSeconds,
        intervalSeconds: session.intervalSeconds,
      });
    });

    registerWatchCommentaryNotifier(conversationId, (_session: WatchSession) => {
      const commentary = lastCommentaryBySession.get(conversationId);
      if (commentary) {
        lastCommentaryBySession.delete(conversationId);
        this.sendToClient({
          type: 'assistant_text_delta',
          text: commentary,
          sessionId: conversationId,
        });
        this.sendToClient({
          type: 'message_complete',
          sessionId: conversationId,
        });
      }
    });

    registerWatchCompletionNotifier(conversationId, (_session: WatchSession) => {
      const summary = lastSummaryBySession.get(conversationId);
      if (summary) {
        lastSummaryBySession.delete(conversationId);
        this.sendToClient({
          type: 'assistant_text_delta',
          text: summary,
          sessionId: conversationId,
        });
        this.sendToClient({
          type: 'message_complete',
          sessionId: conversationId,
        });
      }
    });

    this.executor = new ToolExecutor(this.prompter);
    this.profiler = new ToolProfiler();
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolNotificationListener(this.eventBus, (msg) => this.sendToClient(msg));
    registerToolTraceListener(this.eventBus, this.traceEmitter);
    registerToolProfilingListener(this.eventBus, this.profiler);
    const auditToolLifecycleEvent = createToolAuditListener();
    const publishToolDomainEvent = createToolDomainEventPublisher(this.eventBus);
    const handleToolLifecycleEvent: ToolLifecycleEventHandler = (event) => {
      auditToolLifecycleEvent(event);
      return publishToolDomainEvent(event);
    };

    const toolDefs = [
      ...getAllToolDefinitions(),
      ...allUiSurfaceTools.map((t) => t.getDefinition()),
      ...allAppTools.filter((t) => t.executionMode === 'proxy').map((t) => t.getDefinition()),
      // Escalation tool: allows text_qa sessions to hand off to computer use
      requestComputerControlTool.getDefinition(),
    ];
    const toolExecutor = async (name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => {
      const result = await this.executor.execute(name, input, {
        workingDir: this.workingDir,
        sessionId: this.conversationId,
        conversationId: this.conversationId,
        requestId: this.currentRequestId,
        onOutput,
        signal: this.abortController?.signal,
        sandboxOverride: this.sandboxOverride,
        onToolLifecycleEvent: handleToolLifecycleEvent,
        proxyToolResolver: (toolName: string, input: Record<string, unknown>) => surfaceProxyResolver(this, toolName, input),
        requestSecret: async (params) => {
          return this.secretPrompter.prompt(
            params.service, params.field, params.label,
            params.description, params.placeholder,
            this.conversationId,
            params.purpose, params.allowedTools, params.allowedDomains,
          );
        },
        requestConfirmation: async (req) => {
          // Check trust store before prompting
          const existingRule = findHighestPriorityRule(
            'cc:' + req.toolName,
            [req.toolName, `cc:${req.toolName}`, 'cc:*'],
            this.workingDir,
          );
          if (existingRule && existingRule.decision !== 'ask') {
            return {
              decision: existingRule.decision === 'allow' ? 'allow' as const : 'deny' as const,
            };
          }
          const allowlistOptions = [
            { label: `cc:${req.toolName}`, description: `Claude Code ${req.toolName}`, pattern: `cc:${req.toolName}` },
            { label: 'cc:*', description: 'All Claude Code sub-tools', pattern: 'cc:*' },
          ];
          const scopeOptions = generateScopeOptions(this.workingDir);
          const response = await this.prompter.prompt(
            `cc:${req.toolName}`,
            req.input,
            req.riskLevel,
            allowlistOptions,
            scopeOptions,
            undefined, undefined,
            this.conversationId,
          );
          if (response.decision === 'always_allow' && response.selectedPattern && response.selectedScope) {
            addRule('cc:' + req.toolName, response.selectedPattern, response.selectedScope);
          }
          if (response.decision === 'always_deny' && response.selectedPattern && response.selectedScope) {
            addRule('cc:' + req.toolName, response.selectedPattern, response.selectedScope, 'deny');
          }
          return {
            decision: (response.decision === 'allow' || response.decision === 'always_allow') ? 'allow' as const : 'deny' as const,
          };
        },
      });

      // Auto-refresh workspace surfaces when a persisted app is updated
      if (name === 'app_update' && !result.isError) {
        const appId = input.app_id as string | undefined;
        if (appId) {
          refreshSurfacesForApp(this, appId);
          this.broadcastToAllClients?.({ type: 'app_files_changed', appId });
          void updatePublishedAppDeployment(appId);
        }
      }

      // Auto-refresh workspace surfaces when app files are edited
      if ((name === 'app_file_edit' || name === 'app_file_write') && !result.isError) {
        const appId = input.app_id as string | undefined;
        const status = input.status as string | undefined;
        if (appId) {
          refreshSurfacesForApp(this, appId, { fileChange: true, status });
          this.broadcastToAllClients?.({ type: 'app_files_changed', appId });
          void updatePublishedAppDeployment(appId);
        }
      }

      return result;
    };

    const config = getConfig();
    this.agentLoop = new AgentLoop(
      provider,
      systemPrompt,
      { maxTokens, thinking: config.thinking },
      toolDefs.length > 0 ? toolDefs : undefined,
      toolDefs.length > 0 ? toolExecutor : undefined,
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

  async loadFromDb(): Promise<void> {
    const dbMessages = conversationStore.getMessages(this.conversationId);

    const conv = conversationStore.getConversation(this.conversationId);
    const contextSummary = conv?.contextSummary?.trim() || null;
    this.contextCompactedMessageCount = Math.max(
      0,
      Math.min(conv?.contextCompactedMessageCount ?? 0, dbMessages.length),
    );
    this.contextCompactedAt = conv?.contextCompactedAt ?? null;

    const parsedMessages: Message[] = dbMessages
      .slice(this.contextCompactedMessageCount)
      .map((m) => {
        const role = m.role as 'user' | 'assistant';
        let content: ContentBlock[];
        try {
          const parsed = JSON.parse(m.content);
          content = Array.isArray(parsed) ? parsed : [{ type: 'text', text: m.content }];
        } catch {
          log.warn({ conversationId: this.conversationId, messageId: m.id }, 'Invalid JSON in persisted message content, replacing with safe text block');
          content = [{ type: 'text', text: m.content }];
        }
        return { role, content };
      });

    const { messages: repairedMessages, stats } = repairHistory(parsedMessages);
    if (stats.assistantToolResultsMigrated > 0 || stats.missingToolResultsInserted > 0 || stats.orphanToolResultsDowngraded > 0 || stats.consecutiveSameRoleMerged > 0) {
      log.warn({ conversationId: this.conversationId, phase: 'load', ...stats }, 'Repaired persisted history');
    }
    this.messages = repairedMessages;

    if (contextSummary) {
      this.messages.unshift(createContextSummaryMessage(contextSummary));
    }

    if (conv) {
      this.usageStats = {
        inputTokens: conv.totalInputTokens,
        outputTokens: conv.totalOutputTokens,
        estimatedCost: conv.totalEstimatedCost,
      };
    }

    log.info({ conversationId: this.conversationId, count: this.messages.length }, 'Loaded messages from DB');
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

  /**
   * Set a callback for when a text_qa session escalates to computer use
   * via the `request_computer_control` tool.
   */
  setEscalationHandler(handler: (task: string, sourceSessionId: string) => boolean): void {
    this.onEscalateToComputerUse = handler;
  }

  hasEscalationHandler(): boolean {
    return this.onEscalateToComputerUse !== undefined;
  }

  /**
   * Redirect the user to the secure credential prompt after an ingress block.
   * If the user enters a value, it is stored in the vault (or injected as
   * transient) so the credential is available for later tool use.
   *
   * @param onComplete Called after the prompt resolves (success, cancel, or
   *   timeout) so the caller can clean up ephemeral resources like placeholder
   *   conversations.
   */
  redirectToSecurePrompt(detectedTypes: string[], onComplete?: () => void): void {
    const service = 'detected';
    const field = detectedTypes.join(',');
    this.secretPrompter.prompt(
      service, field,
      'Secure Credential Entry',
      'Your message contained a secret. Please enter it here instead — it will be stored securely and never sent to the AI.',
      undefined, this.conversationId,
    ).then(async (result) => {
      if (!result.value) return; // user cancelled or timed out

      const { setSecureKey } = await import('../security/secure-keys.js');
      const { upsertCredentialMetadata } = await import('../tools/credentials/metadata-store.js');

      if (result.delivery === 'transient_send') {
        const { credentialBroker } = await import('../tools/credentials/broker.js');
        credentialBroker.injectTransient(service, field, result.value);
        try { upsertCredentialMetadata(service, field, {}); } catch {}
        log.info({ service, field, delivery: 'transient_send' }, 'Ingress redirect: transient credential injected');
      } else {
        const key = `credential:${service}:${field}`;
        const stored = setSecureKey(key, result.value);
        if (stored) {
          try { upsertCredentialMetadata(service, field, {}); } catch {}
          log.info({ service, field }, 'Ingress redirect: credential stored');
        } else {
          log.warn({ service, field }, 'Ingress redirect: secure storage write failed');
        }
      }
    }).catch(() => { /* prompt timeout or cancel is fine */ }).finally(() => {
      onComplete?.();
    });
  }

  isProcessing(): boolean {
    return this.processing;
  }

  markStale(): void {
    this.stale = true;
  }

  isStale(): boolean {
    return this.stale;
  }

  abort(): void {
    if (this.processing) {
      log.info({ conversationId: this.conversationId }, 'Aborting in-flight processing');
      this.abortController?.abort();
      this.prompter.dispose();
      this.secretPrompter.dispose();
      this.pendingSurfaceActions.clear();
      this.surfaceState.clear();
      unregisterWatchStartNotifier(this.conversationId);
      unregisterWatchCommentaryNotifier(this.conversationId);
      unregisterWatchCompletionNotifier(this.conversationId);
      pruneWatchSessions(this.conversationId);

      // Clear queued messages and notify each caller with a session-scoped
      // cancel event so other sessions do not receive cross-thread errors.
      for (const queued of this.queue) {
        queued.onEvent({ type: 'generation_cancelled', sessionId: this.conversationId });
      }
      this.queue.clear();
    }
  }

  /** Abort and permanently tear down this session. Call when removing from the sessions map. */
  dispose(): void {
    void getHookManager().trigger('session-end', {
      sessionId: this.conversationId,
    });
    this.abort();
    this.eventBus.dispose();
  }

  /**
   * Enqueue a message if the session is busy, or indicate it should be
   * processed immediately. Returns `{ queued: true }` if the message was
   * added to the queue, `{ queued: false, rejected: true }` if the queue
   * is full, or `{ queued: false }` if the caller should invoke
   * `processMessage` directly.
   */
  enqueueMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent: (msg: ServerMessage) => void,
    requestId: string,
    activeSurfaceId?: string,
    currentPage?: string,
  ): { queued: boolean; rejected?: boolean; requestId: string } {
    if (!this.processing) {
      return { queued: false, requestId };
    }

    const pushed = this.queue.push({ content, attachments, requestId, onEvent, activeSurfaceId, currentPage });
    if (!pushed) {
      return { queued: false, rejected: true, requestId };
    }
    return { queued: true, requestId };
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Returns true if there are messages waiting in the queue.
   */
  hasQueuedMessages(): boolean {
    return !this.queue.isEmpty;
  }

  /**
   * Returns true if the session is currently processing and there are queued
   * messages waiting. This is the predicate used to decide whether to yield
   * at a turn boundary (checkpoint handoff).
   */
  canHandoffAtCheckpoint(): boolean {
    return this.processing && this.hasQueuedMessages();
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

  /**
   * Bind a runtime assistant ID to this session.
   * IPC-only desktop sessions can leave this unset and use a local scope.
   */
  setAssistantId(assistantId: string): void {
    this.assistantId = assistantId;
  }

  private async approveHostAttachmentReadImpl(filePath: string): Promise<boolean> {
    return approveHostAttachmentRead(filePath, this.workingDir, this.prompter, this.conversationId, this.hasNoClient);
  }

  /**
   * Persist a user message and mark the session as processing.
   * Returns the messageId immediately without running the agent loop.
   * After calling this, call `runAgentLoop` to continue processing.
   */
  persistUserMessage(
    content: string,
    attachments: UserMessageAttachment[],
    requestId?: string,
  ): string {
    if (this.processing) {
      throw new Error('Session is already processing a message');
    }

    if (!content.trim() && attachments.length === 0) {
      throw new Error('Message content or attachments are required');
    }

    const reqId = requestId ?? uuid();
    this.currentRequestId = reqId;
    this.processing = true;
    this.abortController = new AbortController();

    const userMessage = createUserMessage(content, attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      data: attachment.data,
      extractedText: attachment.extractedText,
    })));
    this.messages.push(userMessage);

    try {
      const persistedUserMessage = conversationStore.addMessage(
        this.conversationId,
        'user',
        JSON.stringify(userMessage.content),
      );

      if (!persistedUserMessage.id) {
        throw new Error('Failed to persist user message');
      }

      return persistedUserMessage.id;
    } catch (err) {
      this.messages.pop();
      this.processing = false;
      this.abortController = null;
      this.currentRequestId = undefined;
      throw err;
    }
  }

  /**
   * Run the agent loop after a user message has been persisted via
   * `persistUserMessage`. Clears the `processing` flag when done.
   *
   * @param options.skipPreMessageRollback - When true, the pre-message hook
   *   blocked path will NOT delete the user message from in-memory history or
   *   the DB. Used by `regenerate()` where the user message is the original
   *   (not freshly persisted) and must be preserved.
   */
  async runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
    options?: { skipPreMessageRollback?: boolean },
  ): Promise<void> {
    if (!this.abortController) {
      throw new Error('runAgentLoop called without prior persistUserMessage');
    }
    const abortController = this.abortController;
    const reqId = this.currentRequestId ?? uuid();
    const rlog = log.child({ conversationId: this.conversationId, requestId: reqId });
    let yieldedForHandoff = false;

    // Reset attachment state so a failed exchange never retains stale data
    // from a prior successful run.
    this.lastAssistantAttachments = [];
    this.lastAttachmentWarnings = [];

    this.profiler.startRequest();

    try {
      const preMessageResult = await getHookManager().trigger('pre-message', {
        sessionId: this.conversationId,
        messagePreview: content.slice(0, 200),
      });

      if (preMessageResult.blocked) {
        if (!options?.skipPreMessageRollback) {
          // Roll back the user message from both in-memory history and the DB.
          // We use deleteMessageById (not deleteLastExchange) because it NULLs
          // nullable FK references (message_runs, channel_inbound_events) before
          // deleting the message row, so the run record survives.
          this.messages.pop();
          conversationStore.deleteMessageById(userMessageId);
        }
        onEvent({ type: 'error', message: `Message blocked by hook "${preMessageResult.blockedBy}"` });
        return;
      }

      const isFirstMessage = this.messages.length === 1;

      const compacted = await this.contextWindowManager.maybeCompact(
        this.messages,
        abortController.signal,
        { lastCompactedAt: this.contextCompactedAt ?? undefined },
      );
      if (compacted.compacted) {
        this.messages = compacted.messages;
        this.contextCompactedMessageCount += compacted.compactedPersistedMessages;
        this.contextCompactedAt = Date.now();
        conversationStore.updateConversationContextWindow(
          this.conversationId,
          compacted.summaryText,
          this.contextCompactedMessageCount,
        );
        onEvent({
          type: 'context_compacted',
          previousEstimatedInputTokens: compacted.previousEstimatedInputTokens,
          estimatedInputTokens: compacted.estimatedInputTokens,
          maxInputTokens: compacted.maxInputTokens,
          thresholdTokens: compacted.thresholdTokens,
          compactedMessages: compacted.compactedMessages,
          summaryCalls: compacted.summaryCalls,
          summaryInputTokens: compacted.summaryInputTokens,
          summaryOutputTokens: compacted.summaryOutputTokens,
          summaryModel: compacted.summaryModel,
        });
        this.recordUsage(
          compacted.summaryInputTokens,
          compacted.summaryOutputTokens,
          compacted.summaryModel,
          onEvent,
          'context_compactor',
          reqId,
        );
      }

      // Run agent loop
      let firstAssistantText = '';
      let exchangeInputTokens = 0;
      let exchangeOutputTokens = 0;
      let model = '';
      let runMessages = this.messages;
      const pendingToolResults = new Map<string, { content: string; isError: boolean; contentBlocks?: ContentBlock[] }>();
      const persistedToolUseIds = new Set<string>();
      const accumulatedDirectives: DirectiveRequest[] = [];
      const accumulatedToolContentBlocks: ContentBlock[] = [];
      const directiveWarnings: string[] = [];
      let pendingDirectiveDisplayBuffer = '';
      let lastAssistantMessageId: string | undefined;
      const memoryResult = await prepareMemoryContext(
        {
          conversationId: this.conversationId,
          messages: this.messages,
          systemPrompt: this.systemPrompt,
          provider: this.provider,
          conflictGate: this.conflictGate,
        },
        content,
        userMessageId,
        abortController.signal,
        onEvent,
      );

      if (memoryResult.conflictClarification) {
        const assistantMessage = createAssistantMessage(memoryResult.conflictClarification);
        conversationStore.addMessage(
          this.conversationId,
          'assistant',
          JSON.stringify(assistantMessage.content),
        );
        this.messages.push(assistantMessage);
        onEvent({
          type: 'assistant_text_delta',
          text: memoryResult.conflictClarification,
          sessionId: this.conversationId,
        });
        this.traceEmitter.emit('message_complete', 'Conflict clarification requested (relevant)', {
          requestId: reqId,
          status: 'info',
          attributes: { conflictGate: 'relevant' },
        });
        onEvent({ type: 'message_complete', sessionId: this.conversationId });
        return;
      }

      const { recall, dynamicProfile, softConflictInstruction, recallInjectionStrategy } = memoryResult;
      runMessages = memoryResult.runMessages;

      // Inject soft-conflict instruction and active surface context
      let activeSurface: ActiveSurfaceContext | null = null;
      if (this.currentActiveSurfaceId) {
        const stored = this.surfaceState.get(this.currentActiveSurfaceId);
        if (stored && stored.surfaceType === 'dynamic_page') {
          const data = stored.data as DynamicPageSurfaceData;
          activeSurface = {
            surfaceId: this.currentActiveSurfaceId,
            html: data.html,
            currentPage: this.currentPage,
          };
          // Enrich with app context when the surface is backed by a persisted app
          if (data.appId) {
            const app = getApp(data.appId);
            if (app) {
              activeSurface.appId = app.id;
              activeSurface.appName = app.name;
              activeSurface.appSchemaJson = app.schemaJson;
              activeSurface.appFiles = listAppFiles(app.id);
              if (app.pages && Object.keys(app.pages).length > 0) {
                activeSurface.appPages = app.pages;
              }
            }
          }
        }
      }
      // Refresh workspace top-level context before injection
      this.refreshWorkspaceTopLevelContextIfNeeded();

      runMessages = applyRuntimeInjections(runMessages, {
        softConflictInstruction,
        activeSurface,
        workspaceTopLevelContext: this.workspaceTopLevelContext,
      });

      // Pre-run repair: fix any message ordering issues before sending to provider.
      // Keep a reference to the original (un-repaired) messages so we can
      // reconstruct this.messages after the agent loop without leaking synthetic
      // tool_result blocks that repair may inject.  Leaking those blocks would
      // break undo semantics (isUndoableUserMessage skips user messages
      // containing only tool_result blocks).
      let preRepairMessages = runMessages;
      const preRunRepair = repairHistory(runMessages);
      if (preRunRepair.stats.assistantToolResultsMigrated > 0 || preRunRepair.stats.missingToolResultsInserted > 0 || preRunRepair.stats.orphanToolResultsDowngraded > 0 || preRunRepair.stats.consecutiveSameRoleMerged > 0) {
        rlog.warn({ phase: 'pre_run', ...preRunRepair.stats }, 'Repaired runtime history before provider call');
        runMessages = preRunRepair.messages;
      }

      let orderingErrorDetected = false;
      let deferredOrderingError: string | null = null;
      let preRunHistoryLength = runMessages.length;

      // Track whether llm_call_started has been emitted for the current provider turn.
      // Reset on each usage event (which marks the end of a provider call).
      let llmCallStartedEmitted = false;

      // Map tool_use_id → toolName so tool_result processing can identify the originating tool.
      const toolUseIdToName = new Map<string, string>();

      const buildEventHandler = () => (event: import('../agent/loop.js').AgentEvent) => {
        // Emit llm_call_started once per provider call. Called on first streaming
        // token (text or thinking) or, for tool-only turns, right before the
        // usage event so every llm_call_finished has a matching start.
        const emitLlmCallStartedIfNeeded = () => {
          if (llmCallStartedEmitted) return;
          llmCallStartedEmitted = true;
          this.traceEmitter.emit('llm_call_started', `LLM call to ${this.provider.name}`, {
            requestId: reqId,
            status: 'info',
            attributes: { provider: this.provider.name, model: model || 'unknown' },
          });
        };

        switch (event.type) {
          case 'text_delta': {
            emitLlmCallStartedIfNeeded();
            pendingDirectiveDisplayBuffer += event.text;
            const drained = drainDirectiveDisplayBuffer(pendingDirectiveDisplayBuffer);
            pendingDirectiveDisplayBuffer = drained.bufferedRemainder;
            if (drained.emitText.length > 0) {
              onEvent({ type: 'assistant_text_delta', text: drained.emitText, sessionId: this.conversationId });
              if (isFirstMessage) firstAssistantText += drained.emitText;
            }
            break;
          }
          case 'thinking_delta':
            // Thinking content itself is NOT included in traces to avoid leaking
            // extended-thinking data.
            emitLlmCallStartedIfNeeded();
            onEvent({ type: 'assistant_thinking_delta', thinking: event.thinking });
            break;
          case 'tool_use':
            toolUseIdToName.set(event.id, event.name);
            onEvent({ type: 'tool_use_start', toolName: event.name, input: event.input, sessionId: this.conversationId });
            break;
          case 'tool_output_chunk':
            onEvent({ type: 'tool_output_chunk', chunk: event.chunk });
            break;
          case 'input_json_delta':
            onEvent({ type: 'tool_input_delta', toolName: event.toolName, content: event.accumulatedJson, sessionId: this.conversationId });
            break;
          case 'tool_result': {
            const imageBlock = event.contentBlocks?.find((b): b is ImageContent => b.type === 'image');
            onEvent({ type: 'tool_result', toolName: '', result: event.content, isError: event.isError, diff: event.diff, status: event.status, sessionId: this.conversationId, imageData: imageBlock?.source.data });
            pendingToolResults.set(event.toolUseId, { content: event.content, isError: event.isError, contentBlocks: event.contentBlocks });
            // Mark workspace context dirty for mutation tools.
            // file_write and bash are always dirty regardless of isError —
            // file_write may physically write before a post-write error, and
            // bash commands can modify the filesystem even when exiting
            // non-zero (e.g. `mkdir foo && false`, `npm install` with audit
            // warnings, compound commands where early parts succeed).
            // file_edit is only dirty on success — a failed edit provably
            // never touches the filesystem.
            {
              const toolName = toolUseIdToName.get(event.toolUseId);
              if (toolName === 'file_write' || toolName === 'bash') {
                this.markWorkspaceTopLevelDirty();
              } else if (toolName === 'file_edit' && !event.isError) {
                this.markWorkspaceTopLevelDirty();
              }
            }
            // Collect image/file content blocks for assistant attachment conversion
            if (event.contentBlocks) {
              for (const cb of event.contentBlocks) {
                if (cb.type === 'image' || cb.type === 'file') {
                  accumulatedToolContentBlocks.push(cb);
                }
              }
            }
            break;
          }
          case 'error':
            if (isProviderOrderingError(event.error.message)) {
              orderingErrorDetected = true;
              // Defer the error event — only forward if retry also fails
              deferredOrderingError = event.error.message;
            } else {
              const classified = classifySessionError(event.error, { phase: 'agent_loop' });
              onEvent(buildSessionErrorMessage(this.conversationId, classified));
            }
            break;
          case 'message_complete': {
            if (pendingDirectiveDisplayBuffer.length > 0) {
              onEvent({
                type: 'assistant_text_delta',
                text: pendingDirectiveDisplayBuffer,
                sessionId: this.conversationId,
              });
              if (isFirstMessage) firstAssistantText += pendingDirectiveDisplayBuffer;
              pendingDirectiveDisplayBuffer = '';
            }
            // Save pending tool results as a user message before the next assistant message.
            // tool_result blocks belong in user messages per the Anthropic API spec.
            if (pendingToolResults.size > 0) {
              const toolResultBlocks = Array.from(pendingToolResults.entries()).map(
                ([toolUseId, result]) => ({
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: result.content,
                  is_error: result.isError,
                  ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
                }),
              );
              conversationStore.addMessage(
                this.conversationId,
                'user',
                JSON.stringify(toolResultBlocks),
              );
              for (const id of pendingToolResults.keys()) {
                persistedToolUseIds.add(id);
              }
              pendingToolResults.clear();
            }
            // Parse and strip attachment directives from assistant text
            const { cleanedContent, directives: msgDirectives, warnings: msgWarnings } =
              cleanAssistantContent(event.message.content);
            accumulatedDirectives.push(...msgDirectives);
            directiveWarnings.push(...msgWarnings);

            // Add surface blocks to content for persistence
            const contentWithSurfaces: ContentBlock[] = [...cleanedContent as ContentBlock[]];
            for (const surface of this.currentTurnSurfaces) {
              contentWithSurfaces.push({
                type: 'ui_surface',
                surfaceId: surface.surfaceId,
                surfaceType: surface.surfaceType,
                title: surface.title,
                data: surface.data,
                actions: surface.actions,
                display: surface.display,
              } as unknown as ContentBlock);
            }

            // Save assistant message with cleaned content (tags stripped) plus surfaces
            const assistantMsg = conversationStore.addMessage(
              this.conversationId,
              'assistant',
              JSON.stringify(contentWithSurfaces),
            );
            lastAssistantMessageId = assistantMsg.id;

            // Clear surfaces for next turn
            this.currentTurnSurfaces = [];

            // Emit assistant_message trace with content metrics.
            // Char count only includes text blocks; thinking blocks are
            // explicitly excluded from traces.
            const charCount = cleanedContent
              .filter((b) => (b as Record<string, unknown>).type === 'text')
              .reduce((sum: number, b) => sum + ((b as { text?: string }).text?.length ?? 0), 0);
            const toolUseCount = event.message.content
              .filter((b) => b.type === 'tool_use')
              .length;
            this.traceEmitter.emit('assistant_message', 'Assistant message complete', {
              requestId: reqId,
              status: 'success',
              attributes: { charCount, toolUseCount },
            });
            break;
          }
          case 'usage':
            exchangeInputTokens += event.inputTokens;
            exchangeOutputTokens += event.outputTokens;
            model = event.model;

            // Ensure llm_call_started is emitted even for tool-only turns
            // (where no text_delta or thinking_delta events fire)
            emitLlmCallStartedIfNeeded();

            // Emit llm_call_finished trace with token and latency metrics
            this.traceEmitter.emit('llm_call_finished', `LLM call to ${this.provider.name} finished`, {
              requestId: reqId,
              status: 'success',
              attributes: {
                provider: this.provider.name,
                model: event.model,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                latencyMs: event.providerDurationMs,
              },
            });
            // Reset flag so the next provider call in this agent loop run
            // gets its own llm_call_started trace
            llmCallStartedEmitted = false;
            break;
        }
      };

      const onCheckpoint = (): CheckpointDecision => {
        if (this.canHandoffAtCheckpoint()) {
          yieldedForHandoff = true;
          return 'yield';
        }
        return 'continue';
      };

      let updatedHistory = await this.agentLoop.run(
        runMessages,
        buildEventHandler(),
        abortController.signal,
        reqId,
        onCheckpoint,
      );

      // One-shot self-heal retry: if the provider returned a strict ordering
      // error and no messages were appended (error on first call), apply a
      // deep repair (handles additional edge cases like consecutive same-role
      // messages) and retry exactly once.
      if (orderingErrorDetected && updatedHistory.length === preRunHistoryLength) {
        rlog.warn({ phase: 'retry' }, 'Provider ordering error detected, attempting one-shot deep-repair retry');
        const retryRepair = deepRepairHistory(runMessages);
        runMessages = retryRepair.messages;
        // Update preRepairMessages so that structural fixes from deep repair
        // (e.g., stripping leading assistant messages, merging same-role runs)
        // persist in this.messages after the run.  Without this, the original
        // malformed prefix would be restored and trigger the same error next turn.
        preRepairMessages = retryRepair.messages;
        preRunHistoryLength = runMessages.length;
        orderingErrorDetected = false;
        deferredOrderingError = null;

        updatedHistory = await this.agentLoop.run(
          runMessages,
          buildEventHandler(),
          abortController.signal,
          reqId,
          onCheckpoint,
        );

        if (orderingErrorDetected) {
          rlog.error({ phase: 'retry' }, 'Deep-repair retry also failed with ordering error. Consider starting a new conversation if this persists.');
        }
      }

      // Forward the deferred ordering error to the client if retry failed or was not attempted
      if (deferredOrderingError) {
        const classified = classifySessionError(new Error(deferredOrderingError), { phase: 'agent_loop' });
        onEvent(buildSessionErrorMessage(this.conversationId, classified));
      }

      // Reconcile synthesized cancellation tool_results from history tail.
      // When abort happens, the agent loop synthesizes "Cancelled by user"
      // results directly into the history without firing tool_result events,
      // so they're missing from pendingToolResults and would not be persisted.
      for (let i = preRunHistoryLength; i < updatedHistory.length; i++) {
        const msg = updatedHistory[i];
        if (msg.role === 'user') {
          for (const block of msg.content) {
            if (block.type === 'tool_result' && !pendingToolResults.has(block.tool_use_id) && !persistedToolUseIds.has(block.tool_use_id)) {
              pendingToolResults.set(block.tool_use_id, {
                content: block.content,
                isError: block.is_error ?? false,
              });
            }
          }
        }
      }

      // Flush any remaining tool results as a user message
      if (pendingToolResults.size > 0) {
        const toolResultBlocks = Array.from(pendingToolResults.entries()).map(
          ([toolUseId, result]) => ({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: result.content,
            is_error: result.isError,
            ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
          }),
        );
        conversationStore.addMessage(
          this.conversationId,
          'user',
          JSON.stringify(toolResultBlocks),
        );
        pendingToolResults.clear();
      }

      // Reconstruct history: use the original (un-repaired) prefix so that
      // synthetic tool_result blocks from pre-run repair don't leak into
      // this.messages.  Only the new messages appended by the agent loop
      // (beyond the repaired prefix) are carried forward.
      //
      // Strip directive tags from assistant messages so in-memory history
      // matches the cleaned content persisted to the DB. Without this,
      // subsequent turns would send raw <vellum-attachment /> tags to the
      // LLM, wasting tokens and encouraging hallucinated directives.
      const newMessages = updatedHistory.slice(preRunHistoryLength).map((msg) => {
        if (msg.role !== 'assistant') return msg;
        const { cleanedContent } = cleanAssistantContent(msg.content);
        return { ...msg, content: cleanedContent as ContentBlock[] };
      });
      const restoredHistory = [...preRepairMessages, ...newMessages];
      const recallStripped = stripMemoryRecallMessages(restoredHistory, recall.injectedText, recallInjectionStrategy);
      this.messages = stripWorkspaceTopLevelContext(
        stripActiveSurfaceContext(
          stripDynamicProfileMessages(recallStripped, dynamicProfile.text),
        ),
      );

      this.recordUsage(exchangeInputTokens, exchangeOutputTokens, model, onEvent, 'main_agent', reqId);

      void getHookManager().trigger('post-message', {
        sessionId: this.conversationId,
      });

      // Resolve accumulated attachment directives and tool content blocks
      const attachmentResult = await resolveAssistantAttachments(
        accumulatedDirectives,
        accumulatedToolContentBlocks,
        directiveWarnings,
        this.workingDir,
        async (filePath) => this.approveHostAttachmentReadImpl(filePath),
        lastAssistantMessageId,
        this.assistantId ?? 'local-assistant',
      );
      const { assistantAttachments, emittedAttachments } = attachmentResult;

      this.lastAssistantAttachments = assistantAttachments;
      this.lastAttachmentWarnings = attachmentResult.directiveWarnings;

      const warningText = formatAttachmentWarnings(attachmentResult.directiveWarnings);
      if (warningText) {
        onEvent({ type: 'assistant_text_delta', text: warningText, sessionId: this.conversationId });
      }

      if (yieldedForHandoff) {
        this.traceEmitter.emit('generation_handoff', 'Handing off to next queued message', {
          requestId: reqId,
          status: 'info',
          attributes: { queuedCount: this.getQueueDepth() },
        });
        onEvent({
          type: 'generation_handoff',
          sessionId: this.conversationId,
          requestId: reqId,
          queuedCount: this.getQueueDepth(),
          ...(emittedAttachments.length > 0 ? { attachments: emittedAttachments } : {}),
        });
      } else if (abortController.signal.aborted) {
        this.traceEmitter.emit('generation_cancelled', 'Generation cancelled by user', {
          requestId: reqId,
          status: 'warning',
        });
        onEvent({ type: 'generation_cancelled', sessionId: this.conversationId });
      } else {
        this.traceEmitter.emit('message_complete', 'Message processing complete', {
          requestId: reqId,
          status: 'success',
        });
        onEvent({
          type: 'message_complete',
          sessionId: this.conversationId,
          ...(emittedAttachments.length > 0 ? { attachments: emittedAttachments } : {}),
        });
      }

      // Auto-generate conversation title after first exchange
      if (isFirstMessage) {
        this.generateTitle(content, firstAssistantText).catch((err) => {
          log.warn({ err, conversationId: this.conversationId }, 'Failed to generate conversation title (non-fatal, using default title)');
        });
      }
    } catch (err) {
      const errorCtx = { phase: 'agent_loop' as const, aborted: abortController.signal.aborted };
      // AbortError is expected when user cancels — don't treat as an error
      if (isUserCancellation(err, errorCtx)) {
        rlog.info('Generation cancelled by user');
        this.traceEmitter.emit('generation_cancelled', 'Generation cancelled by user', {
          requestId: reqId,
          status: 'warning',
        });
        onEvent({ type: 'generation_cancelled', sessionId: this.conversationId });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const errorClass = err instanceof Error ? err.constructor.name : 'Error';
        rlog.error({ err }, 'Session processing error');
        this.traceEmitter.emit('request_error', message.slice(0, 200), {
          requestId: reqId,
          status: 'error',
          attributes: { errorClass, message: message.slice(0, 500) },
        });
        onEvent({ type: 'error', message: `Failed to process message: ${message}` });
        const classified = classifySessionError(err, errorCtx);
        onEvent(buildSessionErrorMessage(this.conversationId, classified));
        void getHookManager().trigger('on-error', {
          error: err instanceof Error ? err.name : 'Error',
          message,
          stack: err instanceof Error ? err.stack : undefined,
          sessionId: this.conversationId,
        });
      }
    } finally {
      this.profiler.emitSummary(this.traceEmitter, reqId);

      this.abortController = null;
      this.processing = false;
      this.currentRequestId = undefined;
      this.currentActiveSurfaceId = undefined;

      // Consolidate consecutive assistant messages from this agent loop run
      if (userMessageId) {
        this.consolidateAssistantMessages(userMessageId);
      }

      // Drain the next queued message, if any
      this.drainQueue(yieldedForHandoff ? 'checkpoint_handoff' : 'loop_complete');
    }
  }

  private consolidateAssistantMessages(userMessageId: string): void {
    consolidateAssistantMessages(this.conversationId, userMessageId);
  }

  /**
   * Process the next message in the queue, if any.
   * Called from the `runAgentLoop` finally block after processing completes.
   *
   * When a dequeued message fails to persist (e.g. empty content, DB error),
   * `processMessage` catches the error and resolves without calling
   * `runAgentLoop`. Since the drain chain depends on `runAgentLoop`'s `finally`
   * block, we must explicitly continue draining on failure — otherwise
   * remaining queued messages would be stranded.
   */
  private drainQueue(reason: QueueDrainReason = 'loop_complete'): void {
    const next = this.queue.shift();
    if (!next) return;

    log.info({ conversationId: this.conversationId, requestId: next.requestId, reason }, 'Dequeuing message');
    this.traceEmitter.emit('request_dequeued', `Message dequeued (${reason})`, {
      requestId: next.requestId,
      status: 'info',
      attributes: { reason },
    });
    next.onEvent({
      type: 'message_dequeued',
      sessionId: this.conversationId,
      requestId: next.requestId,
    });

    // Resolve slash commands for queued messages
    const slashResult = resolveSlash(next.content);

    // Unknown slash — persist the exchange and continue draining.
    // Persist each message before pushing to this.messages so that a
    // failed write never leaves an unpersisted message in memory.
    if (slashResult.kind === 'unknown') {
      try {
        const userMsg = createUserMessage(next.content, next.attachments);
        conversationStore.addMessage(
          this.conversationId,
          'user',
          JSON.stringify(userMsg.content),
        );
        this.messages.push(userMsg);

        const assistantMsg = createAssistantMessage(slashResult.message);
        conversationStore.addMessage(
          this.conversationId,
          'assistant',
          JSON.stringify(assistantMsg.content),
        );
        this.messages.push(assistantMsg);

        next.onEvent({ type: 'assistant_text_delta', text: slashResult.message });
        this.traceEmitter.emit('message_complete', 'Unknown slash command handled', {
          requestId: next.requestId,
          status: 'success',
        });
        next.onEvent({ type: 'message_complete', sessionId: this.conversationId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, conversationId: this.conversationId, requestId: next.requestId }, 'Failed to persist unknown-slash exchange');
        this.traceEmitter.emit('request_error', `Unknown-slash persist failed: ${message}`, {
          requestId: next.requestId,
          status: 'error',
          attributes: { reason: 'persist_failure' },
        });
        next.onEvent({ type: 'error', message });
      }
      // Continue draining regardless of success/failure
      this.drainQueue();
      return;
    }

    const resolvedContent = slashResult.content;

    // Try to persist and run the dequeued message. If persistUserMessage
    // succeeds, runAgentLoop is called and its finally block will drain
    // the next message. If persistUserMessage fails, processMessage
    // resolves early (no runAgentLoop call), so we must continue draining.
    let userMessageId: string;
    try {
      userMessageId = this.persistUserMessage(resolvedContent, next.attachments, next.requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, conversationId: this.conversationId, requestId: next.requestId }, 'Failed to persist queued message');
      this.traceEmitter.emit('request_error', `Queued message persist failed: ${message}`, {
        requestId: next.requestId,
        status: 'error',
        attributes: { reason: 'persist_failure' },
      });
      next.onEvent({ type: 'error', message });
      // Continue draining — don't strand remaining messages
      this.drainQueue();
      return;
    }

    // Set the active surface for the dequeued message so runAgentLoop can inject context
    this.currentActiveSurfaceId = next.activeSurfaceId;
    this.currentPage = next.currentPage;

    // Fire-and-forget: persistUserMessage set this.processing = true
    // so subsequent messages will still be enqueued. runAgentLoop's
    // finally block will call drainQueue when this run completes.
    this.runAgentLoop(resolvedContent, userMessageId, next.onEvent).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, conversationId: this.conversationId, requestId: next.requestId }, 'Error processing queued message');
      next.onEvent({ type: 'error', message: `Failed to process queued message: ${message}` });
    });
  }

  /**
   * Convenience method that persists a user message and runs the agent loop
   * in a single call. Used by the IPC path where blocking is expected.
   */
  async processMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent: (msg: ServerMessage) => void,
    requestId?: string,
    activeSurfaceId?: string,
    currentPage?: string,
  ): Promise<string> {
    this.currentActiveSurfaceId = activeSurfaceId;
    this.currentPage = currentPage;

    // Resolve slash commands before persistence
    const slashResult = resolveSlash(content);

    // Unknown slash command — persist the exchange (user + assistant) so the
    // messageId is real.  Persist each message before pushing to this.messages
    // so that a failed write never leaves an unpersisted message in memory.
    if (slashResult.kind === 'unknown') {
      const userMsg = createUserMessage(content, attachments);
      const persisted = conversationStore.addMessage(
        this.conversationId,
        'user',
        JSON.stringify(userMsg.content),
      );
      this.messages.push(userMsg);

      const assistantMsg = createAssistantMessage(slashResult.message);
      conversationStore.addMessage(
        this.conversationId,
        'assistant',
        JSON.stringify(assistantMsg.content),
      );
      this.messages.push(assistantMsg);

      onEvent({ type: 'assistant_text_delta', text: slashResult.message });
      this.traceEmitter.emit('message_complete', 'Unknown slash command handled', {
        requestId,
        status: 'success',
      });
      onEvent({ type: 'message_complete', sessionId: this.conversationId });
      return persisted.id;
    }

    const resolvedContent = slashResult.content;

    let userMessageId: string;
    try {
      userMessageId = this.persistUserMessage(resolvedContent, attachments, requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message });
      return '';
    }

    await this.runAgentLoop(resolvedContent, userMessageId, onEvent);
    return userMessageId;
  }

  handleSurfaceAction(surfaceId: string, actionId: string, data?: Record<string, unknown>): void {
    handleSurfaceActionImpl(this, surfaceId, actionId, data);
  }

  getMessages(): Message[] {
    return this.messages;
  }

  undo(): number {
    return undoImpl(this as HistorySessionContext);
  }

  async regenerate(onEvent: (msg: ServerMessage) => void, requestId?: string): Promise<void> {
    return regenerateImpl(this as HistorySessionContext, onEvent, requestId);
  }

  // ── Workspace Top-Level Context ──────────────────────────────────

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

  /**
   * After an app_update, refresh any active surface that displays the updated app.
   * This makes app_update a single call that both persists AND displays changes.
   */
  handleSurfaceUndo(surfaceId: string): void {
    handleSurfaceUndoImpl(this, surfaceId);
  }

  private recordUsage(
    inputTokens: number,
    outputTokens: number,
    model: string,
    onEvent: (msg: ServerMessage) => void,
    actor: UsageActor,
    requestId: string | null = null,
  ): void {
    recordUsage(
      { conversationId: this.conversationId, providerName: this.provider.name, assistantId: this.assistantId, usageStats: this.usageStats },
      inputTokens, outputTokens, model, onEvent, actor, requestId,
    );
  }

  private async generateTitle(userMessage: string, assistantResponse: string): Promise<void> {
    return generateTitle(this.conversationId, userMessage, assistantResponse);
  }

}
