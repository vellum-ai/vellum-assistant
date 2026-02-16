import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  ProviderResponse,
  SendMessageOptions,
  Message,
  ToolDefinition,
  ContentBlock,
} from "../types.js";
import { ProviderError } from "../../util/errors.js";

const TOOL_ID_RE = /[^a-zA-Z0-9_-]/g;

/** Anthropic requires tool_use IDs to match ^[a-zA-Z0-9_-]+$ */
function sanitizeToolId(id: string): string {
  if (!id) return 'empty';
  return id.replace(TOOL_ID_RE, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
    return `x${hex}`;
  });
}

export class AnthropicProvider implements Provider {
  public readonly name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { config, onEvent, signal } = options ?? {};
    try {
      const params: Anthropic.MessageCreateParams = {
        model: this.model,
        max_tokens: 64000,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content
            .map((block) => this.toAnthropicBlock(block))
            .filter((block) => !(block.type === 'text' && !(block as { text?: string }).text?.trim())),
        })).filter((m) => m.content.length > 0),
        ...config,
      };

      if (systemPrompt) {
        params.system = [
          {
            type: 'text' as const,
            text: systemPrompt,
            cache_control: { type: 'ephemeral' as const },
          },
        ];
      }

      if (tools && tools.length > 0) {
        params.tools = tools.map((t, i) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool["input_schema"],
          ...(i === tools.length - 1
            ? { cache_control: { type: 'ephemeral' as const } }
            : {}),
        }));
      }

      // Place cache breakpoints on the last two user turns so the
      // conversation prefix is cached between agent-loop iterations.
      const userIndices: number[] = [];
      for (let i = 0; i < params.messages.length; i++) {
        if (params.messages[i].role === 'user') userIndices.push(i);
      }
      for (const idx of userIndices.slice(-2)) {
        const content = params.messages[idx].content;
        if (Array.isArray(content) && content.length > 0) {
          (content[content.length - 1] as unknown as { cache_control?: { type: string } })
            .cache_control = { type: 'ephemeral' };
        }
      }

      const stream = this.client.messages.stream(params, { signal });

      stream.on("text", (text) => {
        onEvent?.({ type: "text_delta", text });
      });

      stream.on("thinking", (thinking) => {
        onEvent?.({ type: "thinking_delta", thinking });
      });

      const response = await stream.finalMessage();

      return {
        content: response.content.map((block) =>
          this.fromAnthropicBlock(block),
        ),
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens
            + (response.usage.cache_creation_input_tokens ?? 0)
            + (response.usage.cache_read_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
        },
        stopReason: response.stop_reason ?? "unknown",
      };
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ProviderError(
          `Anthropic API error (${error.status}): ${error.message}`,
          'anthropic',
          error.status,
        );
      }
      throw new ProviderError(
        `Anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
        'anthropic',
        undefined,
        { cause: error },
      );
    }
  }

  private toAnthropicBlock(
    block: ContentBlock,
  ): Anthropic.ContentBlockParam {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return { type: "thinking", thinking: block.thinking, signature: block.signature };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };
      case "image":
        return {
          type: "image",
          source: {
            type: "base64",
            media_type:
              block.source.media_type as Anthropic.Base64ImageSource["media_type"],
            data: block.source.data,
          },
        };
      case "file":
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: block.source.media_type,
            data: block.source.data,
          },
          ...(block.source.filename ? { title: block.source.filename } : {}),
        } as unknown as Anthropic.ContentBlockParam;
      case "tool_use":
        return {
          type: "tool_use",
          id: sanitizeToolId(block.id),
          name: block.name,
          input: block.input,
        };
      case "tool_result": {
        const toolUseId = sanitizeToolId(block.tool_use_id);
        if (block.contentBlocks && block.contentBlocks.length > 0) {
          // Build rich content array: text + images for Anthropic's native multi-part tool results
          const parts: Anthropic.ToolResultBlockParam['content'] = [
            { type: "text" as const, text: block.content },
          ];
          for (const cb of block.contentBlocks) {
            if (cb.type === 'image') {
              parts.push({
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: cb.source.media_type as Anthropic.Base64ImageSource["media_type"],
                  data: cb.source.data,
                },
              });
            } else if (cb.type === 'text') {
              parts.push({ type: "text" as const, text: cb.text });
            }
          }
          return {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: parts,
            is_error: block.is_error,
          };
        }
        return {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: block.content,
          is_error: block.is_error,
        };
      }
      default: {
        const _exhaustive: never = block;
        throw new Error(`Unsupported content block type: ${(_exhaustive as ContentBlock).type}`);
      }
    }
  }

  private fromAnthropicBlock(
    block: Anthropic.ContentBlock,
  ): ContentBlock {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return { type: "thinking", thinking: block.thinking, signature: block.signature };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      default:
        return { type: "text", text: `[unsupported block type: ${(block as { type: string }).type}]` };
    }
  }

}
