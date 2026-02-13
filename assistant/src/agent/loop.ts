import * as Sentry from '@sentry/node';
import type { Provider, Message, ToolDefinition, ContentBlock } from '../providers/types.js';
import { getLogger, isDebug, truncateForLog } from '../util/logger.js';
import { getHookManager } from '../hooks/manager.js';

const log = getLogger('agent-loop');

export interface AgentLoopConfig {
  maxTokens: number;
  thinking?: { enabled: boolean; budgetTokens: number };
  toolChoice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
  maxToolUseTurns?: number;
}

export interface CheckpointInfo {
  turnIndex: number;
  toolCount: number;
  hasToolUse: boolean;
}

export type CheckpointDecision = 'continue' | 'yield';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'message_complete'; message: Message }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_output_chunk'; toolUseId: string; chunk: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean }; status?: string }
  | { type: 'error'; error: Error }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; model: string };

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTokens: 64000,
  maxToolUseTurns: 30,
};

const PROGRESS_CHECK_INTERVAL = 5;
const PROGRESS_CHECK_REMINDER = 'You have been using tools for several turns. Check whether you are making meaningful progress toward the user\'s goal. If you are stuck in a loop or not making progress, summarize what you have tried and ask the user for guidance instead of continuing.';

export class AgentLoop {
  private provider: Provider;
  private systemPrompt: string;
  private config: AgentLoopConfig;
  private tools: ToolDefinition[];
  private toolExecutor: ((name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => Promise<{ content: string; isError: boolean; diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean }; status?: string }>) | null;

  constructor(
    provider: Provider,
    systemPrompt: string,
    config?: Partial<AgentLoopConfig>,
    tools?: ToolDefinition[],
    toolExecutor?: (name: string, input: Record<string, unknown>, onOutput?: (chunk: string) => void) => Promise<{ content: string; isError: boolean; diff?: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean }; status?: string }>,
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
    requestId?: string,
    onCheckpoint?: (checkpoint: CheckpointInfo) => CheckpointDecision,
  ): Promise<Message[]> {
    const history = [...messages];
    let toolUseTurns = 0;
    const debug = isDebug();
    const rlog = requestId ? log.child({ requestId }) : log;

    while (true) {
      if (signal?.aborted) break;

      const turnStart = Date.now();

      try {
        const providerConfig: Record<string, unknown> = { max_tokens: this.config.maxTokens };
        if (this.config.thinking?.enabled) {
          // Anthropic requires budget_tokens < max_tokens
          const budgetTokens = Math.min(
            this.config.thinking.budgetTokens,
            this.config.maxTokens - 1,
          );
          providerConfig.thinking = {
            type: 'enabled',
            budget_tokens: budgetTokens,
          };
        }

        if (this.config.toolChoice) {
          providerConfig.tool_choice = this.config.toolChoice;
        }

        if (debug) {
          rlog.debug({
            systemPrompt: truncateForLog(this.systemPrompt, 200),
            messageCount: history.length,
            lastMessage: history.length > 0
              ? summarizeMessage(history[history.length - 1])
              : null,
            toolCount: this.tools.length,
            config: providerConfig,
          }, 'Sending request to provider');
        }

        const preLlmResult = await getHookManager().trigger('pre-llm-call', {
          systemPrompt: this.systemPrompt,
          messages: history,
          toolCount: this.tools.length,
        });

        if (preLlmResult.blocked) {
          onEvent({ type: 'error', error: new Error(`LLM call blocked by hook "${preLlmResult.blockedBy}"`) });
          break;
        }

        const providerStart = Date.now();

        const response = await this.provider.sendMessage(
          history,
          this.tools.length > 0 ? this.tools : undefined,
          this.systemPrompt,
          {
            config: providerConfig,
            onEvent: (event) => {
              if (event.type === 'text_delta') {
                onEvent({ type: 'text_delta', text: event.text });
              } else if (event.type === 'thinking_delta') {
                onEvent({ type: 'thinking_delta', thinking: event.thinking });
              }
            },
            signal,
          },
        );

        const providerDurationMs = Date.now() - providerStart;

        if (debug) {
          rlog.debug({
            providerDurationMs,
            model: response.model,
            stopReason: response.stopReason,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
            cacheReadInputTokens: response.usage.cacheReadInputTokens,
            contentBlocks: response.content.map((b) => ({
              type: b.type,
              ...(b.type === 'text' ? { text: truncateForLog(b.text, 200) } : {}),
              ...(b.type === 'tool_use' ? { name: b.name, input: truncateForLog(JSON.stringify(b.input), 200) } : {}),
            })),
          }, 'Provider response received');
        }

        onEvent({
          type: 'usage',
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
          cacheReadInputTokens: response.usage.cacheReadInputTokens,
          model: response.model,
        });

        void getHookManager().trigger('post-llm-call', {
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          contentBlockCount: response.content.length,
          durationMs: providerDurationMs,
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

        // Emit all tool_use events upfront, then execute tools in parallel
        for (const toolUse of toolUseBlocks) {
          onEvent({
            type: 'tool_use',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });

          if (debug) {
            rlog.debug({
              tool: toolUse.name,
              input: truncateForLog(JSON.stringify(toolUse.input), 300),
            }, 'Executing tool');
          }
        }

        // If already cancelled, synthesize cancelled results and stop
        if (signal?.aborted) {
          const cancelledBlocks: ContentBlock[] = toolUseBlocks.map((toolUse) => ({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: 'Cancelled by user',
            is_error: true,
          }));
          history.push({ role: 'user', content: cancelledBlocks });
          break;
        }

        // Execute all tools concurrently for reduced latency.
        // Race against the abort signal so cancellation isn't blocked by
        // stuck tools (e.g. a hung browser navigation).
        const toolExecutionPromise = Promise.all(
          toolUseBlocks.map(async (toolUse) => {
            const toolStart = Date.now();

            const result = await this.toolExecutor!(toolUse.name, toolUse.input, (chunk) => {
              onEvent({ type: 'tool_output_chunk', toolUseId: toolUse.id, chunk });
            });

            const toolDurationMs = Date.now() - toolStart;

            if (debug) {
              rlog.debug({
                tool: toolUse.name,
                toolDurationMs,
                isError: result.isError,
                output: truncateForLog(result.content, 300),
              }, 'Tool execution complete');
            }

            return { toolUse, result };
          }),
        );

        let toolResults: Awaited<typeof toolExecutionPromise>;
        if (signal && !signal.aborted) {
          let abortHandler!: () => void;
          const abortPromise = new Promise<never>((_, reject) => {
            abortHandler = () => reject(new DOMException('The operation was aborted', 'AbortError'));
            signal.addEventListener('abort', abortHandler, { once: true });
          });
          try {
            toolResults = await Promise.race([toolExecutionPromise, abortPromise]);
          } finally {
            signal.removeEventListener('abort', abortHandler);
            // Suppress unhandled rejection from abandoned tool executions
            toolExecutionPromise.catch(() => {});
          }
        } else {
          toolResults = await toolExecutionPromise;
        }

        // Emit tool_result events in deterministic tool_use order after all complete
        for (const { toolUse, result } of toolResults) {
          onEvent({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: result.content,
            isError: result.isError,
            diff: result.diff,
            status: result.status,
          });
        }

        // Collect result blocks preserving tool_use order (Promise.all maintains order)
        const resultBlocks: ContentBlock[] = toolResults.map(({ toolUse, result }) => ({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.isError,
        }));

        // If cancelled during execution, push completed results and stop
        if (signal?.aborted) {
          history.push({ role: 'user', content: resultBlocks });
          break;
        }

        // Track tool-use turns and inject progress reminder every N turns
        toolUseTurns++;
        if (this.config.maxToolUseTurns && this.config.maxToolUseTurns > 0 && toolUseTurns >= this.config.maxToolUseTurns) {
          const limitMessage = `Tool-use turn limit reached (${this.config.maxToolUseTurns}). Stopping to prevent runaway loops; ask the user for guidance.`;
          onEvent({ type: 'error', error: new Error(limitMessage) });
          resultBlocks.push({
            type: 'text',
            text: `<system_notice>${limitMessage}</system_notice>`,
          });
          history.push({ role: 'user', content: resultBlocks });
          break;
        }
        if (toolUseTurns % PROGRESS_CHECK_INTERVAL === 0) {
          resultBlocks.push({
            type: 'text',
            text: `<system_notice>${PROGRESS_CHECK_REMINDER}</system_notice>`,
          });
        }

        // Add tool results as a user message and continue the loop
        history.push({ role: 'user', content: resultBlocks });

        if (debug) {
          const turnDurationMs = Date.now() - turnStart;
          rlog.debug({
            turnDurationMs,
            providerDurationMs,
            toolCount: toolUseBlocks.length,
            turn: toolUseTurns,
          }, 'Turn complete');
        }

        // Invoke checkpoint callback after tool results are in history
        if (onCheckpoint) {
          const decision = onCheckpoint({
            turnIndex: toolUseTurns - 1, // 0-based (toolUseTurns was already incremented)
            toolCount: toolUseBlocks.length,
            hasToolUse: true,
          });
          if (decision === 'yield') {
            break;
          }
        }
      } catch (error) {
        // Abort errors are expected when user cancels — don't emit as errors
        if (signal?.aborted) break;
        const err = error instanceof Error ? error : new Error(String(error));
        rlog.error({ err, turn: toolUseTurns, messageCount: history.length }, 'Agent loop error during turn processing');
        Sentry.captureException(err);
        onEvent({ type: 'error', error: err });
        break;
      }
    }

    return history;
  }
}

function summarizeMessage(msg: Message): { role: string; blockTypes: string[] } {
  return {
    role: msg.role,
    blockTypes: msg.content.map((b) => b.type),
  };
}
