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
        max_tokens: 8192,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content.map((block) => this.toAnthropicBlock(block)),
        })),
        ...config,
      };

      if (systemPrompt) {
        params.system = systemPrompt;
      }

      if (tools && tools.length > 0) {
        params.tools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool["input_schema"],
        }));
      }

      const stream = this.client.messages.stream(params, { signal });

      stream.on("text", (text) => {
        onEvent?.({ type: "text_delta", text });
      });

      const response = await stream.finalMessage();

      return {
        content: response.content.map((block) =>
          this.fromAnthropicBlock(block),
        ),
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
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
      );
    }
  }

  private toAnthropicBlock(
    block: ContentBlock,
  ): Anthropic.ContentBlockParam {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
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
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        };
    }
  }

  private fromAnthropicBlock(
    block: Anthropic.ContentBlock,
  ): ContentBlock {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      default:
        return { type: "text", text: `[unsupported block type: ${block.type}]` };
    }
  }
}
