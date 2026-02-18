import type { Provider, ProviderResponse, SendMessageOptions, Message, ToolDefinition } from './types.js';
import { getLogfire } from '../logfire.js';

/**
 * Wrapper provider that instruments each sendMessage call with a Logfire span.
 * When Logfire is not initialized, acts as a pure pass-through with zero overhead.
 */
export class LogfireProvider implements Provider {
  public readonly name: string;

  constructor(private readonly inner: Provider) {
    this.name = inner.name;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const logfire = getLogfire();
    if (!logfire) {
      return this.inner.sendMessage(messages, tools, systemPrompt, options);
    }

    const start = Date.now();

    return logfire.span(`llm.${this.name}`, { 'llm.provider': this.name, 'llm.message_count': messages.length, 'llm.tool_count': tools?.length ?? 0 }, {}, async (span) => {
      try {
        const response = await this.inner.sendMessage(messages, tools, systemPrompt, options);
        const durationMs = Date.now() - start;

        span.setAttributes({
          'llm.model': response.model,
          'llm.stop_reason': response.stopReason,
          'llm.usage.input_tokens': response.usage.inputTokens,
          'llm.usage.output_tokens': response.usage.outputTokens,
          'llm.usage.cache_creation_input_tokens': response.usage.cacheCreationInputTokens ?? 0,
          'llm.usage.cache_read_input_tokens': response.usage.cacheReadInputTokens ?? 0,
          'llm.duration_ms': durationMs,
          'llm.success': true,
        });

        return response;
      } catch (error) {
        const durationMs = Date.now() - start;
        span.setAttributes({
          'llm.duration_ms': durationMs,
          'llm.success': false,
          'llm.error.type': error instanceof Error ? error.constructor.name : 'Unknown',
          'llm.error.message': error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }
}
