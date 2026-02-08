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
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean } }
  | { type: 'error'; error: Error }
  | { type: 'usage'; inputTokens: number; outputTokens: number; model: string };

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
  private toolExecutor: ((name: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean; diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean } }>) | null;

  constructor(
    provider: Provider,
    systemPrompt: string,
    config?: Partial<AgentLoopConfig>,
    tools?: ToolDefinition[],
    toolExecutor?: (name: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean; diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean } }>,
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
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const history = [...messages];
    let toolUseTurns = 0;

    while (true) {
      if (signal?.aborted) break;

      try {
        const response = await this.provider.sendMessage(
          history,
          this.tools.length > 0 ? this.tools : undefined,
          this.systemPrompt,
          {
            config: { max_tokens: this.config.maxTokens },
            onEvent: (event) => {
              if (event.type === 'text_delta') {
                onEvent({ type: 'text_delta', text: event.text });
              }
            },
            signal,
          },
        );

        onEvent({
          type: 'usage',
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          model: response.model,
        });

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
          if (signal?.aborted) break;
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
            diff: result.diff,
          });

          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.content,
            is_error: result.isError,
          });
        }

        // If cancelled mid-execution, synthesize cancelled results for
        // any tool_use blocks that weren't executed, so the API contract
        // (every tool_use must have a matching tool_result) is maintained.
        if (signal?.aborted) {
          const completedIds = new Set(
            resultBlocks
              .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
              .map((b) => b.tool_use_id),
          );
          for (const toolUse of toolUseBlocks) {
            if (!completedIds.has(toolUse.id)) {
              resultBlocks.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: 'Cancelled by user',
                is_error: true,
              });
            }
          }
          history.push({ role: 'user', content: resultBlocks });
          break;
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
        // Abort errors are expected when user cancels — don't emit as errors
        if (signal?.aborted) break;
        const err = error instanceof Error ? error : new Error(String(error));
        log.error({ err }, 'Agent loop error');
        onEvent({ type: 'error', error: err });
        break;
      }
    }

    return history;
  }
}
