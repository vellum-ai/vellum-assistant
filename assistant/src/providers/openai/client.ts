import OpenAI from 'openai';
import type {
  Provider,
  ProviderResponse,
  SendMessageOptions,
  Message,
  ToolDefinition,
  ContentBlock,
} from '../types.js';
import { ProviderError } from '../../util/errors.js';

export class OpenAIProvider implements Provider {
  public readonly name = 'openai';
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { config, onEvent, signal } = options ?? {};
    const maxTokens = (config as Record<string, unknown> | undefined)?.max_tokens as number | undefined;

    try {
      const openaiMessages = this.toOpenAIMessages(messages, systemPrompt);

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
        model: this.model,
        messages: openaiMessages,
        stream: true as const,
        stream_options: { include_usage: true },
      };

      if (maxTokens) {
        params.max_completion_tokens = maxTokens;
      }

      if (tools && tools.length > 0) {
        params.tools = tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema as OpenAI.FunctionParameters,
          },
        }));
      }

      const stream = await this.client.chat.completions.create(params, { signal });

      // Accumulate the response from chunks
      let contentText = '';
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
      let finishReason = 'unknown';
      let responseModel = this.model;
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice) {
          if (choice.delta.content) {
            contentText += choice.delta.content;
            onEvent?.({ type: 'text_delta', text: choice.delta.content });
          }

          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!toolCallMap.has(tc.index)) {
                toolCallMap.set(tc.index, { id: '', name: '', args: '' });
              }
              const entry = toolCallMap.get(tc.index)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }

        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }

        responseModel = chunk.model;
      }

      // Build content blocks
      const content: ContentBlock[] = [];
      if (contentText) {
        content.push({ type: 'text', text: contentText });
      }
      for (const [, tc] of toolCallMap) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.args);
        } catch {
          input = { _raw: tc.args };
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input,
        });
      }

      return {
        content,
        model: responseModel,
        usage: { inputTokens: promptTokens, outputTokens: completionTokens },
        stopReason: finishReason,
      };
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new ProviderError(
          `OpenAI API error (${error.status}): ${error.message}`,
          'openai',
          error.status,
        );
      }
      throw new ProviderError(
        `OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`,
        'openai',
        undefined,
        { cause: error },
      );
    }
  }

  /** Convert neutral messages + system prompt to OpenAI message format. */
  private toOpenAIMessages(
    messages: Message[],
    systemPrompt?: string,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        result.push(this.toOpenAIAssistantMessage(msg));
      } else {
        // User messages may contain tool_result blocks mixed with text/image
        const toolResults = msg.content.filter(
          (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
        );
        const otherBlocks = msg.content.filter(
          (b) => b.type !== 'tool_result' && b.type !== 'thinking' && b.type !== 'redacted_thinking',
        );

        // Emit tool results as separate tool-role messages
        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: tr.is_error ? `[ERROR] ${tr.content}` : tr.content,
          });
        }

        // Emit remaining content as a user message (if any)
        if (otherBlocks.length > 0) {
          result.push(this.toOpenAIUserMessage(otherBlocks));
        }
      }
    }

    return result;
  }

  /** Convert an assistant message with text + tool_use blocks to OpenAI format. */
  private toOpenAIAssistantMessage(
    msg: Message,
  ): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
    const textParts: string[] = [];
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
        // thinking, redacted_thinking, image — not applicable for OpenAI assistant messages
      }
    }

    const result: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('') : null,
    };

    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls;
    }

    return result;
  }

  /** Convert user content blocks (text, image) to an OpenAI user message. */
  private toOpenAIUserMessage(
    blocks: ContentBlock[],
  ): OpenAI.Chat.Completions.ChatCompletionUserMessageParam {
    // If only a single text block, use plain string (simpler, fewer tokens)
    if (blocks.length === 1 && blocks[0].type === 'text') {
      return { role: 'user', content: blocks[0].text };
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          parts.push({ type: 'text', text: block.text });
          break;
        case 'image':
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          });
          break;
      }
    }

    return { role: 'user', content: parts };
  }
}
