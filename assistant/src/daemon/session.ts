import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '../providers/types.js';
import type { ServerMessage } from './ipc-protocol.js';
import { AgentLoop } from '../agent/loop.js';
import type { Provider } from '../providers/types.js';
import { createUserMessage } from '../agent/message-types.js';
import * as conversationStore from '../memory/conversation-store.js';
import { PermissionPrompter } from '../permissions/prompter.js';
import { ToolExecutor } from '../tools/executor.js';
import { getAllToolDefinitions } from '../tools/registry.js';
import type { UserDecision } from '../permissions/types.js';
import { getConfig } from '../config/loader.js';
import { estimateCost } from '../util/pricing.js';
import { getLogger } from '../util/logger.js';

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
  private workingDir: string;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalEstimatedCost = 0;

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
    this.prompter = new PermissionPrompter(sendToClient);
    this.executor = new ToolExecutor(this.prompter);

    const toolDefs = getAllToolDefinitions();
    const toolExecutor = async (name: string, input: Record<string, unknown>) => {
      return this.executor.execute(name, input, {
        workingDir: this.workingDir,
        sessionId: this.conversationId,
        conversationId: this.conversationId,
      });
    };

    this.agentLoop = new AgentLoop(
      provider,
      systemPrompt,
      { maxTokens },
      toolDefs.length > 0 ? toolDefs : undefined,
      toolDefs.length > 0 ? toolExecutor : undefined,
    );
  }

  async loadFromDb(): Promise<void> {
    const dbMessages = conversationStore.getMessages(this.conversationId);
    this.messages = dbMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: JSON.parse(m.content),
    }));

    const conv = conversationStore.getConversation(this.conversationId);
    if (conv) {
      this.totalInputTokens = conv.totalInputTokens;
      this.totalOutputTokens = conv.totalOutputTokens;
      this.totalEstimatedCost = conv.totalEstimatedCost;
    }

    log.info({ conversationId: this.conversationId, count: this.messages.length }, 'Loaded messages from DB');
  }

  updateClient(sendToClient: (msg: ServerMessage) => void): void {
    this.prompter.updateSender(sendToClient);
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

      // Run agent loop
      let firstAssistantText = '';
      let exchangeInputTokens = 0;
      let exchangeOutputTokens = 0;
      let model = '';
      const updatedHistory = await this.agentLoop.run(
        this.messages,
        (event) => {
          switch (event.type) {
            case 'text_delta':
              onEvent({ type: 'assistant_text_delta', text: event.text });
              if (isFirstMessage) firstAssistantText += event.text;
              break;
            case 'tool_use':
              onEvent({ type: 'tool_use_start', toolName: event.name, input: event.input });
              break;
            case 'tool_result':
              onEvent({ type: 'tool_result', toolName: '', result: event.content, isError: event.isError, diff: event.diff });
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

      this.messages = updatedHistory;

      // Update cumulative token usage
      if (exchangeInputTokens > 0 || exchangeOutputTokens > 0) {
        this.totalInputTokens += exchangeInputTokens;
        this.totalOutputTokens += exchangeOutputTokens;
        const exchangeCost = estimateCost(exchangeInputTokens, exchangeOutputTokens, model);
        this.totalEstimatedCost += exchangeCost;
        conversationStore.updateConversationUsage(
          this.conversationId,
          this.totalInputTokens,
          this.totalOutputTokens,
          this.totalEstimatedCost,
        );
        onEvent({
          type: 'usage_update',
          inputTokens: exchangeInputTokens,
          outputTokens: exchangeOutputTokens,
          totalInputTokens: this.totalInputTokens,
          totalOutputTokens: this.totalOutputTokens,
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
