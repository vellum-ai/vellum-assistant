import { GoogleGenAI, ApiError } from '@google/genai';
import type * as genai from '@google/genai';
import type {
  Provider,
  ProviderResponse,
  SendMessageOptions,
  Message,
  ToolDefinition,
  ContentBlock,
} from '../types.js';
import { ProviderError } from '../../util/errors.js';

export class GeminiProvider implements Provider {
  public readonly name = 'gemini';
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenAI({ apiKey });
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
      const geminiContents = this.toGeminiContents(messages);

      const geminiConfig: genai.GenerateContentConfig = {};

      if (systemPrompt) {
        geminiConfig.systemInstruction = systemPrompt;
      }
      if (maxTokens) {
        geminiConfig.maxOutputTokens = maxTokens;
      }
      if (signal) {
        geminiConfig.abortSignal = signal;
      }

      if (tools && tools.length > 0) {
        geminiConfig.tools = [{
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.input_schema,
          })),
        }];
      }

      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents: geminiContents,
        config: geminiConfig,
      });

      // Accumulate from streaming chunks
      let fullText = '';
      const functionCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
      let finishReason = 'unknown';
      let promptTokens = 0;
      let outputTokens = 0;
      let responseModel = this.model;

      for await (const chunk of stream) {
        // Extract text delta
        const chunkText = chunk.text;
        if (chunkText) {
          fullText += chunkText;
          onEvent?.({ type: 'text_delta', text: chunkText });
        }

        // Extract function calls
        const calls = chunk.functionCalls;
        if (calls) {
          for (const fc of calls) {
            functionCalls.push({
              id: fc.id ?? `call_${crypto.randomUUID()}`,
              name: fc.name ?? '',
              args: fc.args ?? {},
            });
          }
        }

        // Extract metadata from chunks
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) {
          finishReason = candidate.finishReason;
        }

        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
        }

        if (chunk.modelVersion) {
          responseModel = chunk.modelVersion;
        }
      }

      // Build content blocks
      const content: ContentBlock[] = [];
      if (fullText) {
        content.push({ type: 'text', text: fullText });
      }
      for (const fc of functionCalls) {
        content.push({
          type: 'tool_use',
          id: fc.id,
          name: fc.name,
          input: fc.args,
        });
      }

      return {
        content,
        model: responseModel,
        usage: { inputTokens: promptTokens, outputTokens },
        stopReason: finishReason,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ProviderError(
          `Gemini API error (${error.status}): ${error.message}`,
          'gemini',
          error.status,
        );
      }
      throw new ProviderError(
        `Gemini request failed: ${error instanceof Error ? error.message : String(error)}`,
        'gemini',
        undefined,
        { cause: error },
      );
    }
  }

  /** Convert neutral messages to Gemini Content[] format. */
  private toGeminiContents(messages: Message[]): genai.Content[] {
    const result: genai.Content[] = [];

    // Build a map from tool_use id → function name so tool_result blocks
    // can provide the required `name` field on Gemini's FunctionResponse.
    const toolCallNames = new Map<string, string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolCallNames.set(block.id, block.name);
        }
      }
    }

    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = this.toGeminiParts(msg.content, toolCallNames);
      if (parts.length > 0) {
        result.push({ role, parts });
      }
    }

    return result;
  }

  /** Convert ContentBlock[] to Gemini Part[]. */
  private toGeminiParts(
    blocks: ContentBlock[],
    toolCallNames: Map<string, string>,
  ): genai.Part[] {
    const parts: genai.Part[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          parts.push({ text: block.text });
          break;
        case 'image':
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
          break;
        case 'file':
          if (this.supportsGeminiInlineFile(block.source.media_type)) {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            });
          } else {
            const fallback = block.extracted_text?.trim()
              ? `[Attached file: ${block.source.filename} (${block.source.media_type})]\n${block.extracted_text}`
              : `[Attached file: ${block.source.filename} (${block.source.media_type})]\nNo extracted text available.`;
            parts.push({ text: fallback });
          }
          break;
        case 'tool_use':
          parts.push({
            functionCall: {
              id: block.id,
              name: block.name,
              args: block.input,
            },
          });
          break;
        case 'tool_result': {
          let outputText = block.content;
          if (block.contentBlocks && block.contentBlocks.length > 0) {
            const extraText = block.contentBlocks
              .filter((cb): cb is Extract<ContentBlock, { type: 'text' }> => cb.type === 'text')
              .map((cb) => cb.text);
            if (extraText.length > 0) {
              outputText = outputText + '\n' + extraText.join('\n');
            }
            // Include images as inline data parts alongside the function response
            // (Gemini function responses only support text, but images can be
            // added as sibling parts in the same user message).
            for (const cb of block.contentBlocks) {
              if (cb.type === 'image') {
                parts.push({
                  inlineData: {
                    mimeType: cb.source.media_type,
                    data: cb.source.data,
                  },
                });
              }
            }
          }
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name: toolCallNames.get(block.tool_use_id) ?? block.tool_use_id,
              response: { output: outputText },
            },
          });
          break;
        }
        // thinking, redacted_thinking — not applicable for Gemini
      }
    }

    return parts;
  }

  private supportsGeminiInlineFile(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }
}
