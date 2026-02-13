import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuid } from 'uuid';
import type { Message, ContentBlock } from '../providers/types.js';
import { INTERACTIVE_SURFACE_TYPES } from './ipc-protocol.js';
import type { ServerMessage, UsageStats, UserMessageAttachment, SurfaceType, SurfaceData, ListSurfaceData, DynamicPageSurfaceData, FileUploadSurfaceData, UiSurfaceShow } from './ipc-protocol.js';
import { repairHistory, deepRepairHistory } from './history-repair.js';
import { AgentLoop } from '../agent/loop.js';
import type { CheckpointDecision } from '../agent/loop.js';
import type { Provider } from '../providers/types.js';
import { createUserMessage } from '../agent/message-types.js';
import * as conversationStore from '../memory/conversation-store.js';
import { getApp } from '../memory/app-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ToolLifecycleEventHandler, ToolExecutionResult } from '../tools/types.js';
import { getAllToolDefinitions } from '../tools/registry.js';
import { allUiSurfaceTools } from '../tools/ui-surface/definitions.js';
import { allAppTools } from '../tools/apps/definitions.js';
import { requestComputerControlTool } from '../tools/computer-use/request-computer-control.js';
import type { UserDecision } from '../permissions/types.js';
import { getConfig } from '../config/loader.js';
import { estimateCost, resolvePricing } from '../util/pricing.js';
import { getLogger } from '../util/logger.js';
import { EventBus } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
import { registerTimerCompletionNotifier, unregisterTimerCompletionNotifier } from '../tools/timer/pomodoro.js';
import { createToolDomainEventPublisher } from '../events/tool-domain-event-publisher.js';
import { registerToolMetricsLoggingListener } from '../events/tool-metrics-listener.js';
import { registerToolNotificationListener } from '../events/tool-notification-listener.js';
import { createToolAuditListener } from '../events/tool-audit-listener.js';
import {
  ContextWindowManager,
  createContextSummaryMessage,
  getSummaryFromContextMessage,
} from '../context/window-manager.js';
import {
  buildMemoryRecall,
  injectMemoryRecallIntoUserMessage,
  stripMemoryRecallMessages,
} from '../memory/retriever.js';
import { recordUsageEvent } from '../memory/llm-usage-store.js';
import type { UsageActor } from '../usage/actors.js';

const log = getLogger('session');

interface QueuedMessage {
  content: string;
  attachments: UserMessageAttachment[];
  requestId: string;
  onEvent: (msg: ServerMessage) => void;
}

export const MAX_QUEUE_DEPTH = 10;

/**
 * Describes why a queued message was promoted from the queue.
 * - `loop_complete`: the agent loop finished normally and the next message was drained.
 * - `checkpoint_handoff`: a turn-boundary checkpoint decided to yield to the queued message.
 */
export type QueueDrainReason = 'loop_complete' | 'checkpoint_handoff';

/**
 * Configuration for how/when checkpoint handoff is allowed.
 * When `checkpointHandoffEnabled` is true, the agent loop may yield at
 * a turn boundary if there are queued messages waiting.
 */
export interface QueuePolicy {
  checkpointHandoffEnabled: boolean;
}

export class Session {
  public readonly conversationId: string;
  private provider: Provider;
  private messages: Message[] = [];
  private agentLoop: AgentLoop;
  private processing = false;
  private stale = false;
  private abortController: AbortController | null = null;
  private prompter: PermissionPrompter;
  private executor: ToolExecutor;
  private sendToClient: (msg: ServerMessage) => void;
  private eventBus = new EventBus<AssistantDomainEvents>();
  private workingDir: string;
  private sandboxOverride?: boolean;
  private usageStats: UsageStats = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  private contextWindowManager: ContextWindowManager;
  private contextCompactedMessageCount = 0;
  private currentRequestId?: string;
  private messageQueue: QueuedMessage[] = [];
  private pendingSurfaceActions = new Map<string, {
    surfaceType: SurfaceType;
  }>();
  private surfaceState = new Map<string, { surfaceType: SurfaceType; data: SurfaceData }>();
  private onEscalateToComputerUse?: (task: string, sourceSessionId: string) => boolean;

  constructor(
    conversationId: string,
    provider: Provider,
    systemPrompt: string,
    maxTokens: number,
    sendToClient: (msg: ServerMessage) => void,
    workingDir: string,
  ) {
    this.conversationId = conversationId;
    this.provider = provider;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.prompter = new PermissionPrompter(sendToClient);

    registerTimerCompletionNotifier(conversationId, (timer) => {
      this.sendToClient({
        type: 'timer_completed',
        sessionId: conversationId,
        timerId: timer.id,
        label: timer.label,
        durationMinutes: timer.durationMinutes,
      });
    });
    this.executor = new ToolExecutor(this.prompter);
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolNotificationListener(this.eventBus, (msg) => this.sendToClient(msg));
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
      return this.executor.execute(name, input, {
        workingDir: this.workingDir,
        sessionId: this.conversationId,
        conversationId: this.conversationId,
        requestId: this.currentRequestId,
        onOutput,
        sandboxOverride: this.sandboxOverride,
        onToolLifecycleEvent: handleToolLifecycleEvent,
        proxyToolResolver: this.surfaceProxyResolver.bind(this),
      });
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
  }

  async loadFromDb(): Promise<void> {
    const dbMessages = conversationStore.getMessages(this.conversationId);

    const conv = conversationStore.getConversation(this.conversationId);
    const contextSummary = conv?.contextSummary?.trim() || null;
    this.contextCompactedMessageCount = Math.max(
      0,
      Math.min(conv?.contextCompactedMessageCount ?? 0, dbMessages.length),
    );

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

  updateClient(sendToClient: (msg: ServerMessage) => void): void {
    this.sendToClient = sendToClient;
    this.prompter.updateSender(sendToClient);
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
      this.pendingSurfaceActions.clear();
      this.surfaceState.clear();

      // Clear queued messages and notify each caller
      for (const queued of this.messageQueue) {
        queued.onEvent({ type: 'error', message: 'Session aborted — queued message discarded' });
      }
      this.messageQueue = [];
    }
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
  ): { queued: boolean; rejected?: boolean; requestId: string } {
    if (!this.processing) {
      return { queued: false, requestId };
    }

    if (this.messageQueue.length >= MAX_QUEUE_DEPTH) {
      return { queued: false, rejected: true, requestId };
    }

    this.messageQueue.push({ content, attachments, requestId, onEvent });
    return { queued: true, requestId };
  }

  getQueueDepth(): number {
    return this.messageQueue.length;
  }

  /**
   * Returns true if there are messages waiting in the queue.
   */
  hasQueuedMessages(): boolean {
    return this.messageQueue.length > 0;
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
   */
  async runAgentLoop(
    content: string,
    userMessageId: string,
    onEvent: (msg: ServerMessage) => void,
  ): Promise<void> {
    if (!this.abortController) {
      throw new Error('runAgentLoop called without prior persistUserMessage');
    }
    const abortController = this.abortController;
    const reqId = this.currentRequestId ?? uuid();
    const rlog = log.child({ conversationId: this.conversationId, requestId: reqId });
    let yieldedForHandoff = false;

    try {
      const isFirstMessage = this.messages.length === 1;

      const compacted = await this.contextWindowManager.maybeCompact(
        this.messages,
        abortController.signal,
      );
      if (compacted.compacted) {
        this.messages = compacted.messages;
        this.contextCompactedMessageCount += compacted.compactedPersistedMessages;
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
        );
      }

      // Run agent loop
      let firstAssistantText = '';
      let exchangeInputTokens = 0;
      let exchangeOutputTokens = 0;
      let model = '';
      let runMessages = this.messages;
      const pendingToolResults = new Map<string, { content: string; isError: boolean }>();
      const persistedToolUseIds = new Set<string>();
      const runtimeConfig = getConfig();
      const recallQuery = buildMemoryQuery(content, this.messages);
      const recall = await buildMemoryRecall(recallQuery, this.conversationId, runtimeConfig, {
        excludeMessageIds: [userMessageId],
        signal: abortController.signal,
      });

      onEvent({
        type: 'memory_status',
        enabled: recall.enabled,
        degraded: recall.degraded,
        reason: recall.reason,
        provider: recall.provider,
        model: recall.model,
      });

      if (recall.injectedText.length > 0) {
        const userTail = this.messages[this.messages.length - 1];
        if (userTail && userTail.role === 'user') {
          runMessages = [
            ...this.messages.slice(0, -1),
            injectMemoryRecallIntoUserMessage(userTail, recall.injectedText),
          ];
          onEvent({
            type: 'memory_recalled',
            provider: recall.provider ?? 'unknown',
            model: recall.model ?? 'unknown',
            lexicalHits: recall.lexicalHits,
            semanticHits: recall.semanticHits,
            recencyHits: recall.recencyHits,
            injectedTokens: recall.injectedTokens,
            latencyMs: recall.latencyMs,
          });
        }
      }

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

      const buildEventHandler = () => (event: import('../agent/loop.js').AgentEvent) => {
        switch (event.type) {
          case 'text_delta':
            onEvent({ type: 'assistant_text_delta', text: event.text, sessionId: this.conversationId });
            if (isFirstMessage) firstAssistantText += event.text;
            break;
          case 'thinking_delta':
            onEvent({ type: 'assistant_thinking_delta', thinking: event.thinking });
            break;
          case 'tool_use':
            onEvent({ type: 'tool_use_start', toolName: event.name, input: event.input, sessionId: this.conversationId });
            break;
          case 'tool_output_chunk':
            onEvent({ type: 'tool_output_chunk', chunk: event.chunk });
            break;
          case 'tool_result':
            onEvent({ type: 'tool_result', toolName: '', result: event.content, isError: event.isError, diff: event.diff, status: event.status, sessionId: this.conversationId });
            pendingToolResults.set(event.toolUseId, { content: event.content, isError: event.isError });
            break;
          case 'error':
            if (isProviderOrderingError(event.error.message)) {
              orderingErrorDetected = true;
              // Defer the error event — only forward if retry also fails
              deferredOrderingError = event.error.message;
            } else {
              onEvent({ type: 'error', message: event.error.message });
            }
            break;
          case 'message_complete': {
            // Save pending tool results as a user message before the next assistant message.
            // tool_result blocks belong in user messages per the Anthropic API spec.
            if (pendingToolResults.size > 0) {
              const toolResultBlocks = Array.from(pendingToolResults.entries()).map(
                ([toolUseId, result]) => ({
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: result.content,
                  is_error: result.isError,
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
            // Save assistant message to DB
            conversationStore.addMessage(
              this.conversationId,
              'assistant',
              JSON.stringify(event.message.content),
            );
            break;
          }
          case 'usage':
            exchangeInputTokens += event.inputTokens;
            exchangeOutputTokens += event.outputTokens;
            model = event.model;
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
        onEvent({ type: 'error', message: deferredOrderingError });
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
      const newMessages = updatedHistory.slice(preRunHistoryLength);
      const restoredHistory = [...preRepairMessages, ...newMessages];
      this.messages = stripMemoryRecallMessages(restoredHistory, recall.injectedText);

      this.recordUsage(exchangeInputTokens, exchangeOutputTokens, model, onEvent, 'main_agent');

      if (yieldedForHandoff) {
        onEvent({
          type: 'generation_handoff',
          sessionId: this.conversationId,
          requestId: reqId,
          queuedCount: this.getQueueDepth(),
        });
      } else if (abortController.signal.aborted) {
        onEvent({ type: 'generation_cancelled' });
      } else {
        onEvent({ type: 'message_complete', sessionId: this.conversationId });
      }

      // Auto-generate conversation title after first exchange
      if (isFirstMessage) {
        this.generateTitle(content, firstAssistantText).catch((err) => {
          log.warn({ err, conversationId: this.conversationId }, 'Failed to generate conversation title (non-fatal, using default title)');
        });
      }
    } catch (err) {
      // AbortError is expected when user cancels — don't treat as an error
      if (abortController.signal.aborted) {
        rlog.info('Generation cancelled by user');
        onEvent({ type: 'generation_cancelled' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        rlog.error({ err }, 'Session processing error');
        onEvent({ type: 'error', message: `Failed to process message: ${message}` });
      }
    } finally {
      this.abortController = null;
      this.processing = false;
      this.currentRequestId = undefined;

      // Drain the next queued message, if any
      this.drainQueue(yieldedForHandoff ? 'checkpoint_handoff' : 'loop_complete');
    }
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
    const next = this.messageQueue.shift();
    if (!next) return;

    log.info({ conversationId: this.conversationId, requestId: next.requestId, reason }, 'Dequeuing message');
    next.onEvent({
      type: 'message_dequeued',
      sessionId: this.conversationId,
      requestId: next.requestId,
    });

    // Try to persist and run the dequeued message. If persistUserMessage
    // succeeds, runAgentLoop is called and its finally block will drain
    // the next message. If persistUserMessage fails, processMessage
    // resolves early (no runAgentLoop call), so we must continue draining.
    let userMessageId: string;
    try {
      userMessageId = this.persistUserMessage(next.content, next.attachments, next.requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, conversationId: this.conversationId, requestId: next.requestId }, 'Failed to persist queued message');
      next.onEvent({ type: 'error', message });
      // Continue draining — don't strand remaining messages
      this.drainQueue();
      return;
    }

    // Fire-and-forget: persistUserMessage set this.processing = true
    // so subsequent messages will still be enqueued. runAgentLoop's
    // finally block will call drainQueue when this run completes.
    this.runAgentLoop(next.content, userMessageId, next.onEvent).catch((err) => {
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
  ): Promise<string> {
    let userMessageId: string;
    try {
      userMessageId = this.persistUserMessage(content, attachments, requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message });
      return '';
    }

    await this.runAgentLoop(content, userMessageId, onEvent);
    return userMessageId;
  }

  handleSurfaceAction(surfaceId: string, actionId: string, data?: Record<string, unknown>): void {
    const pending = this.pendingSurfaceActions.get(surfaceId);
    if (!pending) {
      log.warn({ surfaceId, actionId }, 'No pending surface action found');
      return;
    }
    const content = JSON.stringify({
      surfaceAction: true,
      surfaceId,
      surfaceType: pending.surfaceType,
      actionId,
      data: data ?? {},
    });

    const requestId = uuid();
    const onEvent = (msg: ServerMessage) => this.sendToClient(msg);

    const result = this.enqueueMessage(content, [], onEvent, requestId);
    if (result.queued) {
      this.pendingSurfaceActions.delete(surfaceId);
      log.info({ surfaceId, actionId, requestId }, 'Surface action queued (session busy)');
      onEvent({
        type: 'message_queued',
        sessionId: this.conversationId,
        requestId,
        position: this.getQueueDepth(),
      });
      return;
    }

    if (result.rejected) {
      log.error({ surfaceId, actionId }, 'Surface action rejected — queue full');
      onEvent({ type: 'error', message: 'Surface action rejected — session queue is full' });
      return;
    }

    this.pendingSurfaceActions.delete(surfaceId);
    log.info({ surfaceId, actionId, requestId }, 'Processing surface action as follow-up');
    this.processMessage(content, [], onEvent, requestId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, surfaceId, actionId }, 'Error processing surface action');
      onEvent({ type: 'error', message: `Failed to process surface action: ${message}` });
    });
  }

  getMessages(): Message[] {
    return this.messages;
  }

  /**
   * Remove the last user+assistant exchange from memory and DB.
   * Returns the number of messages removed.
   */
  undo(): number {
    if (this.processing) return 0;

    const lastUserIdx = findLastUndoableUserMessageIndex(this.messages);
    if (lastUserIdx === -1) return 0;

    const removed = this.messages.length - lastUserIdx;
    this.messages = this.messages.slice(0, lastUserIdx);

    // Also remove from DB. We may need to call deleteLastExchange multiple
    // times because the DB stores tool_result user messages as separate rows.
    // The in-memory findLastUndoableUserMessageIndex skips these, but the DB's
    // deleteLastExchange only finds the last role='user' row — which may be a
    // tool_result message, leaving the real user message orphaned.
    //
    // Strategy: peel back any trailing tool_result exchanges first, then
    // delete the real user message exchange only if tool_result rows were
    // actually encountered. The do-while handles the case where the last DB
    // exchange is a tool_result row; the flag ensures we only issue the extra
    // deleteLastExchange when the loop peeled back tool_result messages.
    let hadToolResult = false;
    do {
      conversationStore.deleteLastExchange(this.conversationId);
      if (conversationStore.isLastUserMessageToolResult(this.conversationId)) {
        hadToolResult = true;
      } else {
        break;
      }
    } while (true);
    if (hadToolResult) {
      conversationStore.deleteLastExchange(this.conversationId);
    }

    return removed;
  }

  private async surfaceProxyResolver(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    if (toolName === 'request_file') {
      const surfaceId = uuid();
      const prompt = typeof input.prompt === 'string' ? input.prompt : 'Please share a file';
      const acceptedTypes = Array.isArray(input.accepted_types) ? input.accepted_types as string[] : undefined;
      const maxFiles = typeof input.max_files === 'number' ? input.max_files : 1;

      const data: FileUploadSurfaceData = {
        prompt,
        acceptedTypes,
        maxFiles,
      };

      this.surfaceState.set(surfaceId, { surfaceType: 'file_upload', data });

      this.sendToClient({
        type: 'ui_surface_show',
        sessionId: this.conversationId,
        surfaceId,
        surfaceType: 'file_upload',
        title: 'File Request',
        data,
      } as UiSurfaceShow);

      // Non-blocking: return immediately, user action arrives as follow-up message
      this.pendingSurfaceActions.set(surfaceId, { surfaceType: 'file_upload' as SurfaceType });
      return {
        content: JSON.stringify({
          surfaceId,
          status: 'awaiting_user_action',
          message: 'File upload dialog displayed. The uploaded file data will arrive as a follow-up message.',
        }),
        isError: false,
      };
    }

    if (toolName === 'ui_show') {
      const surfaceId = uuid();
      const surfaceType = input.surface_type as SurfaceType;
      const title = typeof input.title === 'string' ? input.title : undefined;
      const data = input.data as SurfaceData;
      const actions = input.actions as Array<{ id: string; label: string; style?: string }> | undefined;
      // Interactive surfaces default to awaiting user action.
      // Lists with selectionMode "none" are passive (no actions emitted) so they don't block.
      const isInteractive = surfaceType === 'list'
        ? ((data as ListSurfaceData).selectionMode ?? 'none') !== 'none'
        : INTERACTIVE_SURFACE_TYPES.includes(surfaceType);
      const awaitAction = (input.await_action as boolean) ?? isInteractive;

      // Track surface state for ui_update merging
      this.surfaceState.set(surfaceId, { surfaceType, data });

      const display = (input.display as string) === 'panel' ? 'panel' : 'inline';

      this.sendToClient({
        type: 'ui_surface_show',
        sessionId: this.conversationId,
        surfaceId,
        surfaceType,
        title,
        data,
        actions: actions?.map(a => ({ id: a.id, label: a.label, style: (a.style ?? 'secondary') as 'primary' | 'secondary' | 'destructive' })),
        display,
      } as unknown as UiSurfaceShow);

      if (awaitAction) {
        this.pendingSurfaceActions.set(surfaceId, { surfaceType });
        return {
          content: JSON.stringify({
            surfaceId,
            status: 'awaiting_user_action',
            message: 'Surface displayed. The user\'s response will arrive as a follow-up message.',
          }),
          isError: false,
        };
      }
      return { content: JSON.stringify({ surfaceId }), isError: false };
    }

    if (toolName === 'ui_update') {
      const surfaceId = input.surface_id as string;
      const patch = input.data as Record<string, unknown>;

      // Merge the partial patch into the stored full surface data
      const stored = this.surfaceState.get(surfaceId);
      let mergedData: SurfaceData;
      if (stored) {
        mergedData = { ...stored.data, ...patch } as SurfaceData;
        stored.data = mergedData;
      } else {
        mergedData = patch as unknown as SurfaceData;
      }

      this.sendToClient({
        type: 'ui_surface_update',
        sessionId: this.conversationId,
        surfaceId,
        data: mergedData,
      });
      return { content: 'Surface updated', isError: false };
    }

    if (toolName === 'ui_dismiss') {
      const surfaceId = input.surface_id as string;
      this.sendToClient({
        type: 'ui_surface_dismiss',
        sessionId: this.conversationId,
        surfaceId,
      });
      this.pendingSurfaceActions.delete(surfaceId);
      this.surfaceState.delete(surfaceId);
      return { content: 'Surface dismissed', isError: false };
    }

    if (toolName === 'request_computer_control') {
      const task = typeof input.task === 'string' ? input.task : 'Perform the requested task';
      if (!this.onEscalateToComputerUse) {
        return {
          content: 'Computer control escalation is not available in this session.',
          isError: true,
        };
      }
      const success = this.onEscalateToComputerUse(task, this.conversationId);
      if (!success) {
        return {
          content: 'Computer control escalation failed — no active connection.',
          isError: true,
        };
      }
      return {
        content: 'Computer control activated. The task has been handed off to foreground computer use.',
        isError: false,
      };
    }

    if (toolName === 'app_open') {
      const appId = input.app_id as string;
      const app = getApp(appId);
      if (!app) return { content: `App not found: ${appId}`, isError: true };

      const surfaceId = uuid();
      this.surfaceState.set(surfaceId, {
        surfaceType: 'dynamic_page',
        data: { html: app.htmlDefinition, appId: app.id } as DynamicPageSurfaceData,
      });

      this.sendToClient({
        type: 'ui_surface_show',
        sessionId: this.conversationId,
        surfaceId,
        surfaceType: 'dynamic_page',
        title: app.name,
        data: { html: app.htmlDefinition, appId: app.id },
      } as UiSurfaceShow);

      return { content: JSON.stringify({ surfaceId, appId }), isError: false };
    }

    return { content: `Unknown proxy tool: ${toolName}`, isError: true };
  }

  private recordUsage(
    inputTokens: number,
    outputTokens: number,
    model: string,
    onEvent: (msg: ServerMessage) => void,
    actor: UsageActor,
  ): void {
    if (inputTokens <= 0 && outputTokens <= 0) return;

    const estimatedCost = estimateCost(inputTokens, outputTokens, model, this.provider.name);
    this.usageStats = {
      inputTokens: this.usageStats.inputTokens + inputTokens,
      outputTokens: this.usageStats.outputTokens + outputTokens,
      estimatedCost: this.usageStats.estimatedCost + estimatedCost,
    };
    conversationStore.updateConversationUsage(
      this.conversationId,
      this.usageStats.inputTokens,
      this.usageStats.outputTokens,
      this.usageStats.estimatedCost,
    );
    onEvent({
      type: 'usage_update',
      inputTokens,
      outputTokens,
      totalInputTokens: this.usageStats.inputTokens,
      totalOutputTokens: this.usageStats.outputTokens,
      estimatedCost,
      model,
    });

    // Dual-write: persist per-turn usage event to the new ledger table
    try {
      const pricing = resolvePricing(this.provider.name, model, inputTokens, outputTokens);
      recordUsageEvent(
        {
          actor,
          provider: this.provider.name,
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          assistantId: null,
          conversationId: this.conversationId,
          runId: null,
          requestId: null,
        },
        pricing,
      );
    } catch (err) {
      log.warn({ err, conversationId: this.conversationId }, 'Failed to persist usage event (non-fatal)');
    }
  }

  private async generateTitle(userMessage: string, assistantResponse: string): Promise<void> {
    const config = getConfig();
    const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `Generate a short title (3-6 words, no quotes) for this conversation:\n\nUser: ${userMessage.slice(0, 200)}\nAssistant: ${assistantResponse.slice(0, 200)}`,
      }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      const title = textBlock.text.trim().replace(/^["']|["']$/g, '');
      conversationStore.updateConversationTitle(this.conversationId, title);
      log.info({ conversationId: this.conversationId, title }, 'Auto-generated conversation title');
    }
  }
}

function isUndoableUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (getSummaryFromContextMessage(message) !== null) return false;
  // A user message is undoable if it contains user-authored content (non-tool_result
  // blocks). Messages that contain ONLY tool_result blocks (e.g. automated tool
  // responses) are not undoable. Messages that have both tool_result and text blocks
  // (e.g. after repairHistory merges a tool_result turn with a user prompt) are still
  // undoable because they contain real user content.
  const hasNonToolResultContent = message.content.some(
    (block) => block.type !== 'tool_result',
  );
  if (!hasNonToolResultContent) return false;
  return true;
}

export function findLastUndoableUserMessageIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUndoableUserMessage(messages[i])) {
      return i;
    }
  }
  return -1;
}

const ORDERING_ERROR_PATTERNS = [
  /tool_result.*not immediately after.*tool_use/i,
  /tool_use.*must have.*tool_result/i,
  /tool_use_id.*without.*tool_result/i,
  /tool_result.*tool_use_id.*not found/i,
  /messages.*invalid.*order/i,
];

function isProviderOrderingError(message: string): boolean {
  return ORDERING_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function buildMemoryQuery(content: string, messages: Message[]): string {
  const summaryText = messages
    .map((message) => getSummaryFromContextMessage(message))
    .find((summary): summary is string => summary !== null) ?? '';
  const compactSummary = summaryText.slice(0, 1200);
  return compactSummary.length > 0
    ? `${content}\n\nContext summary:\n${compactSummary}`
    : content;
}
