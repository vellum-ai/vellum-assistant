import type { Provider, Message, ToolDefinition, ContentBlock } from '../providers/types.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('agent-loop');

export interface AgentLoopConfig {
  maxTokens: number;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message_complete'; message: Message }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'error'; error: Error };

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTokens: 4096,
};

const PROGRESS_CHECK_INTERVAL = 5;
const PROGRESS_CHECK_REMINDER = 'You have been using tools for several turns. Check whether you are making meaningful progress toward the user\'s goal. If you are stuck in a loop or not making progress, summarize what you have tried and ask the user for guidance instead of continuing.';

export class AgentLoop {
  private provider: Provider;
  private systemPrompt: string;
  private config: AgentLoopConfig;
  private tools: ToolDefinition[];
  private toolExecutor: ((name: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>) | null;

  constructor(
    provider: Provider,
    systemPrompt: string,
    config?: Partial<AgentLoopConfig>,
    tools?: ToolDefinition[],
    toolExecutor?: (name: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>,
  ) {
    this.provider = provider;
    this.systemPrompt = systemPrompt;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tools = tools ?? [];
    this.toolExecutor = toolExecutor ?? null;
  }

  async run(
    messages: Message[],
    onEvent: (event: AgentEvent) => void,
  ): Promise<Message[]> {
    const history = [...messages];
    let toolUseTurns = 0;

    while (true) {

      try {
        const response = await this.provider.sendMessage(
          history,
          this.tools.length > 0 ? this.tools : undefined,
          this.systemPrompt,
          { max_tokens: this.config.maxTokens },
          (event) => {
            if (event.type === 'text_delta') {
              onEvent({ type: 'text_delta', text: event.text });
            }
          },
        );

        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content,
        };
        history.push(assistantMessage);

        onEvent({ type: 'message_complete', message: assistantMessage });

        // Check for tool use
        const toolUseBlocks = response.content.filter(
          (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
            block.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0 || !this.toolExecutor) {
          // No tool calls or no executor — done
          break;
        }

        // Execute tools and collect results
        const resultBlocks: ContentBlock[] = [];
        for (const toolUse of toolUseBlocks) {
          onEvent({
            type: 'tool_use',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });

          const result = await this.toolExecutor(toolUse.name, toolUse.input);

          onEvent({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: result.content,
            isError: result.isError,
          });

          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        // Track tool-use turns and inject progress reminder every N turns
        toolUseTurns++;
        if (toolUseTurns % PROGRESS_CHECK_INTERVAL === 0) {
          resultBlocks.push({
            type: 'text',
            text: `[System: ${PROGRESS_CHECK_REMINDER}]`,
          });
        }

        // Add tool results as a user message and continue the loop
        history.push({ role: 'user', content: resultBlocks });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error({ err }, 'Agent loop error');
        onEvent({ type: 'error', error: err });
        break;
      }
    }

    return history;
  }
}
