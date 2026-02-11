import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../providers/types.js';
import type { ServerMessage, UsageStats, UserMessageAttachment } from './ipc-protocol.js';
import { AgentLoop } from '../agent/loop.js';
import type { Provider } from '../providers/types.js';
import { createUserMessage } from '../agent/message-types.js';
import * as conversationStore from '../memory/conversation-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ToolLifecycleEventHandler } from '../tools/types.js';
import { getAllToolDefinitions } from '../tools/registry.js';
import type { UserDecision } from '../permissions/types.js';
import { getConfig } from '../config/loader.js';
import { estimateCost } from '../util/pricing.js';
import { getLogger } from '../util/logger.js';
import { EventBus } from '../events/bus.js';
import type { AssistantDomainEvents } from '../events/domain-events.js';
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

const log = getLogger('session');

export class Session {
  public readonly conversationId: string;
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

  constructor(
    conversationId: string,
    provider: Provider,
    systemPrompt: string,
    maxTokens: number,
    sendToClient: (msg: ServerMessage) => void,
    workingDir: string,
  ) {
    this.conversationId = conversationId;
    this.workingDir = workingDir;
    this.sendToClient = sendToClient;
    this.prompter = new PermissionPrompter(sendToClient);
    this.executor = new ToolExecutor(this.prompter);
    registerToolMetricsLoggingListener(this.eventBus);
    registerToolNotificationListener(this.eventBus, (msg) => this.sendToClient(msg));
    const auditToolLifecycleEvent = createToolAuditListener();
    const publishToolDomainEvent = createToolDomainEventPublisher(this.eventBus);
    const handleToolLifecycleEvent: ToolLifecycleEventHandler = (event) => {
      auditToolLifecycleEvent(event);
      return publishToolDomainEvent(event);
    };

    const toolDefs = getAllToolDefinitions();
    const toolExecutor = async (name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => {
      return this.executor.execute(name, input, {
        workingDir: this.workingDir,
        sessionId: this.conversationId,
        conversationId: this.conversationId,
        onOutput,
        sandboxOverride: this.sandboxOverride,
        onToolLifecycleEvent: handleToolLifecycleEvent,
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

    this.messages = dbMessages
      .slice(this.contextCompactedMessageCount)
      .map((m) => {
        const role = m.role as 'user' | 'assistant';
        const content = JSON.parse(m.content);
        // Strip tool_result blocks from assistant messages (legacy data from
        // patchToolResults which injected them in the wrong role).
        if (role === 'assistant' && Array.isArray(content)) {
          const cleaned = content.filter(
            (block: Record<string, unknown>) => block.type !== 'tool_result',
          );
          return { role, content: cleaned };
        }
        return { role, content };
      });

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
    }
  }

  handleConfirmationResponse(
    requestId: string,
    decision: UserDecision,
    selectedPattern?: string,
    selectedScope?: string,
  ): void {
    this.prompter.resolveConfirmation(requestId, decision, selectedPattern, selectedScope);
  }

  async processMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent: (msg: ServerMessage) => void,
  ): Promise<void> {
    if (this.processing) {
      onEvent({ type: 'error', message: 'Already processing a message' });
      return;
    }

    this.processing = true;
    this.abortController = new AbortController();

    try {
      const isFirstMessage = this.messages.length === 0;
      if (!content.trim() && attachments.length === 0) {
        onEvent({ type: 'error', message: 'Message content or attachments are required' });
        return;
      }

      // Add user message
      const userMessage = createUserMessage(content, attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        data: attachment.data,
        extractedText: attachment.extractedText,
      })));
      this.messages.push(userMessage);
      const persistedUserMessage = conversationStore.addMessage(
        this.conversationId,
        'user',
        JSON.stringify(userMessage.content),
      );

      const compacted = await this.contextWindowManager.maybeCompact(
        this.messages,
        this.abortController.signal,
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
        );
      }

      // Run agent loop
      let firstAssistantText = '';
      let exchangeInputTokens = 0;
      let exchangeOutputTokens = 0;
      let model = '';
      let runMessages = this.messages;
      const pendingToolResults = new Map<string, { content: string; isError: boolean }>();
      const runtimeConfig = getConfig();
      const recallQuery = buildMemoryQuery(content, this.messages);
      const recall = await buildMemoryRecall(recallQuery, this.conversationId, runtimeConfig, {
        excludeMessageIds: [persistedUserMessage.id],
        signal: this.abortController.signal,
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

      const updatedHistory = await this.agentLoop.run(
        runMessages,
        (event) => {
          switch (event.type) {
            case 'text_delta':
              onEvent({ type: 'assistant_text_delta', text: event.text });
              if (isFirstMessage) firstAssistantText += event.text;
              break;
            case 'thinking_delta':
              onEvent({ type: 'assistant_thinking_delta', thinking: event.thinking });
              break;
            case 'tool_use':
              onEvent({ type: 'tool_use_start', toolName: event.name, input: event.input });
              break;
            case 'tool_output_chunk':
              onEvent({ type: 'tool_output_chunk', chunk: event.chunk });
              break;
            case 'tool_result':
              onEvent({ type: 'tool_result', toolName: '', result: event.content, isError: event.isError, diff: event.diff, status: event.status });
              pendingToolResults.set(event.toolUseId, { content: event.content, isError: event.isError });
              break;
            case 'error':
              onEvent({ type: 'error', message: event.error.message });
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
        },
        this.abortController.signal,
      );

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

      this.messages = stripMemoryRecallMessages(updatedHistory, recall.injectedText);

      this.recordUsage(exchangeInputTokens, exchangeOutputTokens, model, onEvent);

      if (this.abortController?.signal.aborted) {
        onEvent({ type: 'generation_cancelled' });
      } else {
        onEvent({ type: 'message_complete' });
      }

      // Auto-generate conversation title after first exchange
      if (isFirstMessage) {
        this.generateTitle(content, firstAssistantText).catch((err) => {
          log.warn({ err }, 'Failed to generate conversation title');
        });
      }
    } catch (err) {
      // AbortError is expected when user cancels — don't treat as an error
      if (this.abortController?.signal.aborted) {
        log.info({ conversationId: this.conversationId }, 'Generation cancelled by user');
        onEvent({ type: 'generation_cancelled' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, 'Session processing error');
        onEvent({ type: 'error', message });
      }
    } finally {
      this.abortController = null;
      this.processing = false;
    }
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

    // Also remove from DB
    conversationStore.deleteLastExchange(this.conversationId);

    return removed;
  }

  private recordUsage(
    inputTokens: number,
    outputTokens: number,
    model: string,
    onEvent: (msg: ServerMessage) => void,
  ): void {
    if (inputTokens <= 0 && outputTokens <= 0) return;

    const estimatedCost = estimateCost(inputTokens, outputTokens, model);
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
  if (message.content.some((block) => block.type === 'tool_result')) return false;
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

function buildMemoryQuery(content: string, messages: Message[]): string {
  const summaryText = messages
    .map((message) => getSummaryFromContextMessage(message))
    .find((summary): summary is string => summary !== null) ?? '';
  const compactSummary = summaryText.slice(0, 1200);
  return compactSummary.length > 0
    ? `${content}\n\nContext summary:\n${compactSummary}`
    : content;
}
