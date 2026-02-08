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
import { getLogger } from '../util/logger.js';

const log = getLogger('session');

export class Session {
  public readonly conversationId: string;
  private messages: Message[] = [];
  private agentLoop: AgentLoop;
  private processing = false;
  private prompter: PermissionPrompter;
  private executor: ToolExecutor;
  private workingDir: string;

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
    log.info({ conversationId: this.conversationId, count: this.messages.length }, 'Loaded messages from DB');
  }

  updateClient(sendToClient: (msg: ServerMessage) => void): void {
    this.prompter.updateSender(sendToClient);
  }

  abort(): void {
    if (this.processing) {
      log.info({ conversationId: this.conversationId }, 'Aborting in-flight processing');
      this.prompter.dispose();
      this.processing = false;
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

    try {
      // Add user message
      const userMessage = createUserMessage(content);
      this.messages.push(userMessage);
      conversationStore.addMessage(
        this.conversationId,
        'user',
        JSON.stringify(userMessage.content),
      );

      // Run agent loop
      const updatedHistory = await this.agentLoop.run(
        this.messages,
        (event) => {
          switch (event.type) {
            case 'text_delta':
              onEvent({ type: 'assistant_text_delta', text: event.text });
              break;
            case 'tool_use':
              onEvent({ type: 'tool_use_start', toolName: event.name, input: event.input });
              break;
            case 'tool_result':
              onEvent({ type: 'tool_result', toolName: '', result: event.content, isError: event.isError });
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
          }
        },
      );

      this.messages = updatedHistory;
      onEvent({ type: 'message_complete' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Session processing error');
      onEvent({ type: 'error', message });
    } finally {
      this.processing = false;
    }
  }
}
