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
import { ToolExecutor } from '../tools/executor.js';
import type { UserDecision } from '../permissions/types.js';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { TraceEmitter } from './trace-emitter.js';
import { classifySessionError, isUserCancellation, isContextTooLarge, buildSessionErrorMessage } from './session-error.js';
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
import {
  registerCallQuestionNotifier,
  unregisterCallQuestionNotifier,
  registerCallCompletionNotifier,
  unregisterCallCompletionNotifier,
} from '../calls/call-state.js';
import { getCallSession, getCallEvents } from '../calls/call-store.js';
import { createToolDomainEventPublisher } from '../events/tool-domain-event-publisher.js';
import { registerToolMetricsLoggingListener } from '../events/tool-metrics-listener.js';
import { registerToolNotificationListener } from '../events/tool-notification-listener.js';
import { registerToolTraceListener } from '../events/tool-trace-listener.js';
import { createToolAuditListener } from '../events/tool-audit-listener.js';
import { ToolProfiler, registerToolProfilingListener } from '../events/tool-profiling-listener.js';
import {
  ContextWindowManager,
  createContextSummaryMessage,
  getSummaryFromContextMessage,
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
  stripChannelCapabilityContext,
} from './session-runtime-assembly.js';
import type {
  ActiveSurfaceContext,
  ChannelCapabilities,
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
} from './session-surfaces.js';
import { prepareMemoryContext } from './session-memory.js';
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
import { recordUsage } from './session-usage.js';
import { recordRequestLog } from '../memory/llm-request-log-store.js';
import { isProviderOrderingError } from './session-slash.js';
import { refreshWorkspaceTopLevelContextIfNeeded as refreshWorkspaceImpl } from './session-workspace.js';
import type { UsageActor } from '../usage/actors.js';
import {
  drainQueue as drainQueueImpl,
  processMessage as processMessageImpl,
  type ProcessSessionContext,
} from './session-process.js';
import {
  buildToolDefinitions,
  createToolExecutor,
  type ToolSetupContext,
} from './session-tool-setup.js';
import { unregisterSessionSender } from '../tools/browser/browser-screencast.js';
import { projectSkillTools, resetSkillToolProjection } from './session-skill-tools.js';
import { commitTurnChanges } from '../workspace/turn-commit.js';
import { getWorkspaceGitService } from '../workspace/git-service.js';

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

const log = getLogger('session');
const RETRY_KEEP_LATEST_MEDIA_BLOCKS = 3;
const MAX_MEDIA_STUB_TEXT = 2_000;

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
  /** @internal — exposed for session-tool-setup.ts module functions. */
  sandboxOverride?: boolean;
  /** @internal — per-turn allowed tool set, read by the tool executor closure. */
  allowedToolNames?: Set<string>;
  /** @internal — request-scoped skill IDs preactivated via slash resolution. */
  preactivatedSkillIds?: string[];
  /** Core tool names (computed once in constructor), always allowed regardless of skill state. */
  private coreToolNames: Set<string>;
  /** Per-session tracking of previously active skill IDs and their version hashes for projection diffing. */
  private readonly skillProjectionState = new Map<string, string>();
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
  /** @internal — exposed for session-tool-setup.ts to propagate into ToolContext. */
  hasNoClient = false;
  /** @internal — exposed for session-process.ts module functions. */
  readonly queue = new MessageQueue();
  /** @internal — exposed for session-process.ts module functions. */
  currentActiveSurfaceId?: string;
  /** @internal — exposed for session-process.ts module functions. */
  currentPage?: string;
  private channelCapabilities?: ChannelCapabilities;
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
  public memoryPolicy: SessionMemoryPolicy;
  /** Monotonically increasing turn counter for turn-boundary commits. */
  private turnCount = 0;

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
    memoryPolicy?: SessionMemoryPolicy,
  ) {
    this.conversationId = conversationId;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.broadcastToAllClients = broadcastToAllClients;
    this.memoryPolicy = memoryPolicy ? { ...memoryPolicy } : { ...DEFAULT_MEMORY_POLICY };
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

    // ── Call notifiers (same pattern as watch notifiers) ──
    registerCallQuestionNotifier(conversationId, (callSessionId: string, question: string) => {
      const callSession = getCallSession(callSessionId);
      const callee = callSession?.toNumber ?? 'the caller';
      const questionText = `**Live call question** (to ${callee}):\n\n${question}\n\n_Reply in this thread to answer._`;

      // Persist as an assistant message so it appears in history
      conversationStore.addMessage(
        conversationId,
        'assistant',
        JSON.stringify([{ type: 'text', text: questionText }]),
      );

      // Emit to active clients in real-time
      this.sendToClient({
        type: 'assistant_text_delta',
        text: questionText,
        sessionId: conversationId,
      });
      this.sendToClient({
        type: 'message_complete',
        sessionId: conversationId,
      });
    });

    registerCallCompletionNotifier(conversationId, (callSessionId: string) => {
      const callSession = getCallSession(callSessionId);
      const events = getCallEvents(callSessionId);
      const duration = callSession?.endedAt && callSession?.startedAt
        ? Math.round((callSession.endedAt - callSession.startedAt) / 1000)
        : null;
      const durationStr = duration !== null ? ` (${duration}s)` : '';
      const summaryText = `**Call completed**${durationStr}. ${events.length} event(s) recorded.`;

      // Persist as an assistant message
      conversationStore.addMessage(
        conversationId,
        'assistant',
        JSON.stringify([{ type: 'text', text: summaryText }]),
      );

      // Emit to active clients
      this.sendToClient({
        type: 'assistant_text_delta',
        text: summaryText,
        sessionId: conversationId,
      });
      this.sendToClient({
        type: 'message_complete',
        sessionId: conversationId,
      });
    });

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
    // Build a resolveTools callback that merges base tool definitions with
    // dynamically projected skill tools on each agent turn. Also updates
    // allowedToolNames so newly-activated skill tools aren't blocked by
    // the executor's stale gate.
    const resolveTools = toolDefs.length > 0
      ? (history: Message[]) => {
          const projection = projectSkillTools(history, {
            preactivatedSkillIds: this.preactivatedSkillIds,
            previouslyActiveSkillIds: this.skillProjectionState,
          });
          const turnAllowed = new Set(this.coreToolNames);
          for (const name of projection.allowedToolNames) {
            turnAllowed.add(name);
          }
          this.allowedToolNames = turnAllowed;
          return [...toolDefs, ...projection.toolDefinitions];
        }
      : undefined;

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
   * via the `computer_use_request_control` tool.
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
      unregisterCallQuestionNotifier(this.conversationId);
      unregisterCallCompletionNotifier(this.conversationId);

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
    // Unconditionally unregister call notifiers (abort() only cleans up
    // when processing is true, but notifiers are registered in the
    // constructor regardless of processing state).
    unregisterCallQuestionNotifier(this.conversationId);
    unregisterCallCompletionNotifier(this.conversationId);
    unregisterSessionSender(this.conversationId);
    resetSkillToolProjection(this.skillProjectionState);
    this.eventBus.dispose();

    // Release heavy in-memory data so GC can reclaim it even if stale
    // closure references (e.g. from buildEventHandler / onCheckpoint)
    // keep this Session object reachable.
    this.messages = [];
    this.profiler.clear();
    this.surfaceUndoStacks.clear();
    this.currentTurnSurfaces = [];
    this.pendingSurfaceActions.clear();
    this.surfaceState.clear();
    this.lastSurfaceAction.clear();
    this.workspaceTopLevelContext = null;
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
   * Remove a queued message by requestId. Returns true if the message was found
   * and removed, false if the requestId was not in the queue.
   */
  removeQueuedMessage(requestId: string): boolean {
    return this.queue.removeByRequestId(requestId) !== undefined;
  }

  /**
   * Returns true if the session is currently processing and there are queued
   * messages waiting. This is the predicate used to decide whether to yield
   * at a turn boundary (checkpoint handoff).
   */
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

  /**
   * Bind a runtime assistant ID to this session.
   * IPC-only desktop sessions can leave this unset and use a local scope.
   */
  setAssistantId(assistantId: string): void {
    this.assistantId = assistantId;
  }

  setChannelCapabilities(caps: ChannelCapabilities): void {
    this.channelCapabilities = caps;
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

    // Ensure the workspace git repo is initialized before any tools run.
    // This must happen before the first turn so the initial commit captures
    // the pre-turn workspace state; otherwise ensureInitialized() would be
    // triggered lazily by getStatus() inside commitTurnChanges(), absorbing
    // the first turn's file changes into the initial commit.
    try {
      const gitService = getWorkspaceGitService(this.workingDir);
      await gitService.ensureInitialized();
    } catch (err) {
      rlog.warn({ err }, 'Failed to initialize workspace git repo (non-fatal)');
    }

    this.profiler.startRequest();

    // Tracks whether the agent loop started — once true, we guarantee a
    // turn-boundary commit even if post-processing throws.
    let turnStarted = false;

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
      let providerErrorUserMessage: string | null = null;
      const memoryResult = await prepareMemoryContext(
        {
          conversationId: this.conversationId,
          messages: this.messages,
          systemPrompt: this.systemPrompt,
          provider: this.provider,
          conflictGate: this.conflictGate,
          scopeId: this.memoryPolicy.scopeId,
          includeDefaultFallback: this.memoryPolicy.includeDefaultFallback,
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
        channelCapabilities: this.channelCapabilities ?? null,
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
      let contextTooLargeDetected = false;
      let preRunHistoryLength = runMessages.length;

      // Track whether llm_call_started has been emitted for the current provider turn.
      // Reset on each usage event (which marks the end of a provider call).
      let llmCallStartedEmitted = false;

      // Map tool_use_id → toolName so tool_result processing can identify the originating tool.
      const toolUseIdToName = new Map<string, string>();

      // Track tool names used in the current agent turn for checkpoint decisions.
      let currentTurnToolNames: string[] = [];

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
            currentTurnToolNames.push(event.name);
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
            } else if (isContextTooLarge(event.error.message)) {
              contextTooLargeDetected = true;
              // Defer — attempt compaction + retry before surfacing to user
            } else {
              const classified = classifySessionError(event.error, { phase: 'agent_loop' });
              onEvent(buildSessionErrorMessage(this.conversationId, classified));
              providerErrorUserMessage = classified.userMessage;
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
            if (msgDirectives.length > 0) {
              rlog.info(
                { parsedDirectives: msgDirectives.map(d => ({ source: d.source, path: d.path, mimeType: d.mimeType })), totalAccumulated: accumulatedDirectives.length },
                'Parsed attachment directives from assistant message',
              );
            }

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

            // Persist raw LLM request/response payloads for diagnostics export
            if (event.rawRequest && event.rawResponse) {
              try {
                recordRequestLog(
                  this.conversationId,
                  JSON.stringify(event.rawRequest),
                  JSON.stringify(event.rawResponse),
                );
              } catch (err) {
                rlog.warn({ err }, 'Failed to persist LLM request log (non-fatal)');
              }
            }

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
        // Capture and reset tool names for this turn
        const turnTools = currentTurnToolNames;
        currentTurnToolNames = [];

        if (this.canHandoffAtCheckpoint()) {
          // Don't interrupt active browser interaction flows — the agent
          // needs multiple consecutive turns (snapshot → click → snapshot)
          // and yielding mid-flow leaves the task incomplete.
          const inBrowserFlow = turnTools.length > 0
            && turnTools.every(n => n.startsWith('browser_'));
          if (!inBrowserFlow) {
            yieldedForHandoff = true;
            return 'yield';
          }
        }
        return 'continue';
      };

      // Mark that the agent loop is about to run — workspace files may be
      // modified from this point onward, so we must commit at the turn boundary
      // even if post-processing (e.g. resolveAssistantAttachments) throws.
      turnStarted = true;

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

      // One-shot context-too-large recovery: force compaction and retry once.
      if (contextTooLargeDetected && updatedHistory.length === preRunHistoryLength) {
        rlog.warn({ phase: 'retry' }, 'Context too large — attempting forced compaction and retry');
        const emergencyCompact = await this.contextWindowManager.maybeCompact(
          this.messages,
          abortController.signal,
          { lastCompactedAt: this.contextCompactedAt ?? undefined, force: true },
        );
        if (emergencyCompact.compacted) {
          this.messages = emergencyCompact.messages;
          this.contextCompactedMessageCount += emergencyCompact.compactedPersistedMessages;
          this.contextCompactedAt = Date.now();
          conversationStore.updateConversationContextWindow(
            this.conversationId,
            emergencyCompact.summaryText,
            this.contextCompactedMessageCount,
          );
          onEvent({
            type: 'context_compacted',
            previousEstimatedInputTokens: emergencyCompact.previousEstimatedInputTokens,
            estimatedInputTokens: emergencyCompact.estimatedInputTokens,
            maxInputTokens: emergencyCompact.maxInputTokens,
            thresholdTokens: emergencyCompact.thresholdTokens,
            compactedMessages: emergencyCompact.compactedMessages,
            summaryCalls: emergencyCompact.summaryCalls,
            summaryInputTokens: emergencyCompact.summaryInputTokens,
            summaryOutputTokens: emergencyCompact.summaryOutputTokens,
            summaryModel: emergencyCompact.summaryModel,
          });
          this.recordUsage(
            emergencyCompact.summaryInputTokens,
            emergencyCompact.summaryOutputTokens,
            emergencyCompact.summaryModel,
            onEvent,
            'context_compactor',
            reqId,
          );

          // Retry with compacted context
          runMessages = applyRuntimeInjections(this.messages, {
            softConflictInstruction,
            activeSurface,
            workspaceTopLevelContext: this.workspaceTopLevelContext,
          });
          preRepairMessages = runMessages;
          preRunHistoryLength = runMessages.length;
          contextTooLargeDetected = false;

          updatedHistory = await this.agentLoop.run(
            runMessages,
            buildEventHandler(),
            abortController.signal,
            reqId,
            onCheckpoint,
          );
        }

        if (contextTooLargeDetected) {
          const mediaTrimmed = stripMediaPayloadsForRetry(this.messages);
          if (mediaTrimmed.modified) {
            rlog.warn(
              {
                phase: 'retry',
                replacedBlocks: mediaTrimmed.replacedBlocks,
                latestUserIndex: mediaTrimmed.latestUserIndex,
              },
              'Context still too large — retrying with older media payloads trimmed',
            );
            this.messages = mediaTrimmed.messages;
            runMessages = applyRuntimeInjections(this.messages, {
              softConflictInstruction,
              activeSurface,
              workspaceTopLevelContext: this.workspaceTopLevelContext,
            });
            preRepairMessages = runMessages;
            preRunHistoryLength = runMessages.length;
            contextTooLargeDetected = false;

            updatedHistory = await this.agentLoop.run(
              runMessages,
              buildEventHandler(),
              abortController.signal,
              reqId,
              onCheckpoint,
            );
          }
        }

        // Surface the error if compaction didn't help or wasn't possible
        if (contextTooLargeDetected) {
          const classified = classifySessionError(
            new Error('context_length_exceeded'),
            { phase: 'agent_loop' },
          );
          onEvent(buildSessionErrorMessage(this.conversationId, classified));
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

      // If no assistant response was produced (e.g. provider 500 error),
      // synthesize an assistant message so the error is visible in the conversation.
      const hasAssistantResponse = newMessages.some((msg) => msg.role === 'assistant');
      if (!hasAssistantResponse && providerErrorUserMessage && !abortController.signal.aborted && !yieldedForHandoff) {
        const errorAssistantMessage = createAssistantMessage(providerErrorUserMessage);
        conversationStore.addMessage(
          this.conversationId,
          'assistant',
          JSON.stringify(errorAssistantMessage.content),
        );
        newMessages.push(errorAssistantMessage);
        onEvent({
          type: 'assistant_text_delta',
          text: providerErrorUserMessage,
          sessionId: this.conversationId,
        });
      }

      const restoredHistory = [...preRepairMessages, ...newMessages];
      const recallStripped = stripMemoryRecallMessages(restoredHistory, recall.injectedText, recallInjectionStrategy);
      this.messages = stripChannelCapabilityContext(
        stripWorkspaceTopLevelContext(
          stripActiveSurfaceContext(
            stripDynamicProfileMessages(recallStripped, dynamicProfile.text),
          ),
        ),
      );

      this.recordUsage(exchangeInputTokens, exchangeOutputTokens, model, onEvent, 'main_agent', reqId);

      void getHookManager().trigger('post-message', {
        sessionId: this.conversationId,
      });

      // Resolve accumulated attachment directives and tool content blocks
      // BEFORE emitting the completion event so attachments are included.
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

      // Emit the completion event here in the try block; the turn-boundary
      // commit runs in `finally` (after this), so the client's
      // thinking/streaming indicators clear immediately without waiting
      // for the git commit (which can take 0.5–2 s on large workspaces).
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
      // Turn-boundary commit: runs after completion/error events (try or
      // catch) but before drainQueue.  Guarantees a commit attempt whenever
      // the agent loop started, even if post-processing threw.
      if (turnStarted) {
        this.turnCount++;
        const config = getConfig();
        const maxWait = config.workspaceGit?.turnCommitMaxWaitMs ?? 4000;
        const deadlineMs = Date.now() + maxWait;
        const commitPromise = commitTurnChanges(
          this.workingDir, this.conversationId, this.turnCount,
          undefined, // use default commit message provider
          deadlineMs,
        );
        const outcome = await raceWithTimeout(commitPromise, maxWait);
        if (outcome === 'timed_out') {
          rlog.warn(
            { turnNumber: this.turnCount, maxWaitMs: maxWait, conversationId: this.conversationId },
            'Turn-boundary commit timed out — continuing without waiting (commit still runs in background)',
          );
        }
      }

      this.profiler.emitSummary(this.traceEmitter, reqId);

      this.abortController = null;
      this.processing = false;
      this.currentRequestId = undefined;
      this.currentActiveSurfaceId = undefined;
      this.allowedToolNames = undefined;
      this.preactivatedSkillIds = undefined;

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

  private drainQueue(reason: QueueDrainReason = 'loop_complete'): void {
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
    const prompt = `Generate a very short title for this conversation. Rules: at most 5 words, at most 40 characters, no quotes.\n\nUser: ${userMessage.slice(0, 200)}\nAssistant: ${assistantResponse.slice(0, 200)}`;
    const response = await this.provider.sendMessage(
      [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      [], // no tools
      undefined, // no system prompt
      { config: { max_tokens: 30 } },
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      let title = textBlock.text.trim().replace(/^["']|["']$/g, '');
      const words = title.split(/\s+/);
      if (words.length > 5) title = words.slice(0, 5).join(' ');
      if (title.length > 40) title = title.slice(0, 40).trimEnd();
      conversationStore.updateConversationTitle(this.conversationId, title);
      log.info({ conversationId: this.conversationId, title }, 'Auto-generated conversation title');
    }
  }

}

function stripMediaPayloadsForRetry(messages: Message[]): { messages: Message[]; modified: boolean; replacedBlocks: number; latestUserIndex: number | null } {
  let latestUserIndex: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (getSummaryFromContextMessage(msg) !== null) continue;
    if (isToolResultOnlyMessage(msg)) continue;
    latestUserIndex = i;
    break;
  }

  let modified = false;
  let replacedBlocks = 0;
  let keptLatestMediaBlocks = 0;

  const nextMessages = messages.map((msg, msgIndex) => {
    const nextContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'image') {
        const keep = latestUserIndex === msgIndex && keptLatestMediaBlocks < RETRY_KEEP_LATEST_MEDIA_BLOCKS;
        if (keep) {
          keptLatestMediaBlocks += 1;
          nextContent.push(block);
        } else {
          replacedBlocks += 1;
          modified = true;
          nextContent.push(imageBlockToStub(block));
        }
        continue;
      }

      if (block.type === 'file') {
        const keep = latestUserIndex === msgIndex && keptLatestMediaBlocks < RETRY_KEEP_LATEST_MEDIA_BLOCKS;
        if (keep) {
          keptLatestMediaBlocks += 1;
          nextContent.push(block);
        } else {
          replacedBlocks += 1;
          modified = true;
          nextContent.push(fileBlockToStub(block));
        }
        continue;
      }

      if (block.type === 'tool_result' && block.contentBlocks && block.contentBlocks.length > 0) {
        let toolResultChanged = false;
        const nextToolContentBlocks: ContentBlock[] = block.contentBlocks.map((cb) => {
          if (cb.type === 'image') {
            replacedBlocks += 1;
            modified = true;
            toolResultChanged = true;
            return imageBlockToStub(cb);
          }
          if (cb.type === 'file') {
            replacedBlocks += 1;
            modified = true;
            toolResultChanged = true;
            return fileBlockToStub(cb);
          }
          return cb;
        });
        if (toolResultChanged) {
          nextContent.push({ ...block, contentBlocks: nextToolContentBlocks });
        } else {
          nextContent.push(block);
        }
        continue;
      }

      nextContent.push(block);
    }
    return { ...msg, content: nextContent };
  });

  return {
    messages: modified ? nextMessages : messages,
    modified,
    replacedBlocks,
    latestUserIndex,
  };
}

function imageBlockToStub(block: Extract<ContentBlock, { type: 'image' }>): Extract<ContentBlock, { type: 'text' }> {
  const sizeBytes = Math.ceil(block.source.data.length / 4) * 3;
  return {
    type: 'text',
    text: `[Image omitted from retry context: ${block.source.media_type}, ${sizeBytes} bytes]`,
  };
}

function fileBlockToStub(block: Extract<ContentBlock, { type: 'file' }>): Extract<ContentBlock, { type: 'text' }> {
  const sizeBytes = Math.ceil(block.source.data.length / 4) * 3;
  const extracted = (block.extracted_text ?? '').trim();
  const preview = extracted.length > MAX_MEDIA_STUB_TEXT
    ? `${extracted.slice(0, MAX_MEDIA_STUB_TEXT)}...`
    : extracted;
  return {
    type: 'text',
    text: preview.length > 0
      ? `[File omitted from retry context: ${block.source.filename} (${block.source.media_type}, ${sizeBytes} bytes)]\n${preview}`
      : `[File omitted from retry context: ${block.source.filename} (${block.source.media_type}, ${sizeBytes} bytes)]`,
  };
}

function isToolResultOnlyMessage(message: Message): boolean {
  return message.content.length > 0
    && message.content.every((block) => block.type === 'tool_result');
}

/**
 * Race a promise against a timeout. Returns 'completed' if the promise
 * resolves/rejects within the budget, or 'timed_out' if the timeout fires
 * first. The timer is always cleared in `finally` to prevent handle leaks.
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<'completed' | 'timed_out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise.then(() => 'completed' as const, () => 'completed' as const),
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
