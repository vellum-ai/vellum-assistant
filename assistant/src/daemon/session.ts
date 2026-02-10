import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../providers/types.js';
import type { ServerMessage, UsageStats } from './ipc-protocol.js';
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
} from '../context/window-manager.js';
import {
  buildMemoryRecall,
  createMemoryRecallMessage,
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
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: JSON.parse(m.content),
      }));

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

      // Add user message
      const userMessage = createUserMessage(content);
      this.messages.push(userMessage);
      conversationStore.addMessage(
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
        this.contextCompactedMessageCount += compacted.compactedMessages;
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
      }

      // Run agent loop
      let firstAssistantText = '';
      let exchangeInputTokens = 0;
      let exchangeOutputTokens = 0;
      let model = '';
      let runMessages = this.messages;
      const runtimeConfig = getConfig();
      const recallQuery = buildMemoryQuery(content, this.messages);
      const recall = await buildMemoryRecall(recallQuery, this.conversationId, runtimeConfig);

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
        if (userTail) {
          runMessages = [
            ...this.messages.slice(0, -1),
            createMemoryRecallMessage(recall.injectedText),
            userTail,
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
              break;
            case 'error':
              onEvent({ type: 'error', message: event.error.message });
              break;
            case 'message_complete':
              // Save assistant message to DB
              conversationStore.addMessage(
                this.conversationId,
                'assistant',
                JSON.stringify(event.message.content),
              );
              break;
            case 'usage':
              exchangeInputTokens += event.inputTokens;
              exchangeOutputTokens += event.outputTokens;
              model = event.model;
              break;
          }
        },
        this.abortController.signal,
      );

      this.messages = stripMemoryRecallMessages(updatedHistory);

      // Update cumulative token usage
      if (exchangeInputTokens > 0 || exchangeOutputTokens > 0) {
        const exchangeCost = estimateCost(exchangeInputTokens, exchangeOutputTokens, model);
        this.usageStats = {
          inputTokens: this.usageStats.inputTokens + exchangeInputTokens,
          outputTokens: this.usageStats.outputTokens + exchangeOutputTokens,
          estimatedCost: this.usageStats.estimatedCost + exchangeCost,
        };
        conversationStore.updateConversationUsage(
          this.conversationId,
          this.usageStats.inputTokens,
          this.usageStats.outputTokens,
          this.usageStats.estimatedCost,
        );
        onEvent({
          type: 'usage_update',
          inputTokens: exchangeInputTokens,
          outputTokens: exchangeOutputTokens,
          totalInputTokens: this.usageStats.inputTokens,
          totalOutputTokens: this.usageStats.outputTokens,
          estimatedCost: exchangeCost,
          model,
        });
      }

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

    // Find last user message in memory
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return 0;

    const removed = this.messages.length - lastUserIdx;
    this.messages = this.messages.slice(0, lastUserIdx);

    // Also remove from DB
    conversationStore.deleteLastExchange(this.conversationId);

    return removed;
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

function buildMemoryQuery(content: string, messages: Message[]): string {
  const summaryMessage = messages.find((message) =>
    message.role === 'assistant'
    && message.content.some((block) => block.type === 'text' && block.text.includes('[Context Summary v1]')),
  );
  const summaryText = summaryMessage
    ? summaryMessage.content
      .filter((block): block is Extract<typeof summaryMessage.content[number], { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    : '';
  const compactSummary = summaryText.slice(0, 1200);
  return compactSummary.length > 0
    ? `${content}\n\nContext summary:\n${compactSummary}`
    : content;
}
