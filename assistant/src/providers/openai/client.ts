import OpenAI from "openai";

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../prompts/cache-boundary.js";
import { ProviderError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { extractRetryAfterMs } from "../../util/retry.js";
import { escapeXmlAttr } from "../../util/xml.js";
import { createStreamTimeout } from "../stream-timeout.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../types.js";

const log = getLogger("openai-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Validate an OpenAI API key by making a lightweight GET /v1/models call.
 * Returns `{ valid: true }` on success or `{ valid: false, reason: string }` on failure.
 */
export async function validateOpenAIApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const client = new OpenAI({
      apiKey,
      timeout: VALIDATION_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.models.list();
    return { valid: true };
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        return { valid: false, reason: "API key is invalid or expired." };
      }
      if (error.status === 403) {
        return {
          valid: false,
          reason: `OpenAI API error (${error.status}): ${error.message}`,
        };
      }
      // Transient errors (429, 5xx, etc.) — validation is inconclusive,
      // allow the key to be stored rather than blocking the user.
      log.warn(
        { status: error.status },
        "OpenAI API returned a transient error during key validation — allowing key storage",
      );
      return { valid: true };
    }
    // Network errors — validation is inconclusive, allow key storage.
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Network error during OpenAI key validation — allowing key storage",
    );
    return { valid: true };
  }
}

export interface OpenAICompatibleProviderOptions {
  baseURL?: string;
  providerName?: string;
  providerLabel?: string;
  streamTimeoutMs?: number;
  /** Extra params spread into every chat.completions.create call (e.g. reasoning). */
  extraCreateParams?: Record<string, unknown>;
}

const OPENAI_SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export class OpenAIProvider implements Provider {
  public readonly name: string;
  private readonly providerLabel: string;
  private client: OpenAI;
  private model: string;
  private streamTimeoutMs: number;
  private extraCreateParams: Record<string, unknown>;

  constructor(
    apiKey: string,
    model: string,
    options: OpenAICompatibleProviderOptions = {},
  ) {
    this.name = options.providerName ?? "openai";
    this.providerLabel = options.providerLabel ?? "OpenAI";
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL,
    });
    this.model = model;
    this.streamTimeoutMs = options.streamTimeoutMs ?? 300_000;
    this.extraCreateParams = options.extraCreateParams ?? {};
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const { config, onEvent, signal } = options ?? {};
    const configObj = config as Record<string, unknown> | undefined;
    const maxTokens = configObj?.max_tokens as number | undefined;
    const modelOverride = configObj?.model as string | undefined;

    try {
      const openaiMessages = this.toOpenAIMessages(messages, systemPrompt);

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming =
        {
          model: modelOverride ?? this.model,
          messages: openaiMessages,
          stream: true as const,
          stream_options: { include_usage: true },
          ...this.extraCreateParams,
        };

      if (maxTokens) {
        params.max_completion_tokens = maxTokens;
      }

      if (tools && tools.length > 0) {
        params.tools = tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema as OpenAI.FunctionParameters,
          },
        }));
      }

      const { signal: timeoutSignal, cleanup: cleanupTimeout } =
        createStreamTimeout(this.streamTimeoutMs, signal);

      // Accumulate the response from chunks
      let contentText = "";
      const toolCallMap = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      let finishReason = "unknown";
      let responseModel = modelOverride ?? this.model;
      let promptTokens = 0;
      let completionTokens = 0;

      try {
        const stream = await this.client.chat.completions.create(params, {
          signal: timeoutSignal,
        });

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (choice) {
            if (choice.delta.content) {
              contentText += choice.delta.content;
              onEvent?.({ type: "text_delta", text: choice.delta.content });
            }

            if (choice.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                if (!toolCallMap.has(tc.index)) {
                  toolCallMap.set(tc.index, { id: "", name: "", args: "" });
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
      } finally {
        cleanupTimeout();
      }

      // Build content blocks
      const content: ContentBlock[] = [];
      if (contentText) {
        content.push({ type: "text", text: contentText });
      }
      for (const [, tc] of toolCallMap) {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.args);
        } catch {
          input = { _raw: tc.args };
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input,
        });
      }

      // Build a synthetic response object from accumulated streaming data
      const rawResponse = {
        model: responseModel,
        choices: [
          {
            message: {
              role: "assistant",
              content: contentText || null,
              tool_calls:
                toolCallMap.size > 0
                  ? Array.from(toolCallMap.values()).map((tc) => ({
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: tc.args },
                    }))
                  : undefined,
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        },
      };

      return {
        content,
        model: responseModel,
        usage: { inputTokens: promptTokens, outputTokens: completionTokens },
        stopReason: finishReason,
        rawRequest: params,
        rawResponse,
      };
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        const retryAfterMs = extractRetryAfterMs(error.headers);
        throw new ProviderError(
          `${this.providerLabel} API error (${error.status}): ${error.message}`,
          this.name,
          error.status,
          retryAfterMs !== undefined ? { retryAfterMs } : undefined,
        );
      }
      throw new ProviderError(
        `${this.providerLabel} request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.name,
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
      result.push({
        role: "system",
        content: systemPrompt.replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n"),
      });
    }

    for (const msg of messages) {
      if (msg.role === "assistant") {
        result.push(this.toOpenAIAssistantMessage(msg));
      } else {
        // User messages may contain tool_result blocks mixed with text/image
        const toolResults = msg.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_result" }> =>
            b.type === "tool_result",
        );
        const otherBlocks = msg.content.filter(
          (b) =>
            b.type !== "tool_result" &&
            b.type !== "thinking" &&
            b.type !== "redacted_thinking",
        );

        // Emit tool results as separate tool-role messages
        // OpenAI's API only supports string content in tool messages, so images
        // from contentBlocks are collected and injected as a user message below.
        const toolResultImages: ContentBlock[] = [];
        for (const tr of toolResults) {
          let textContent = tr.content;
          if (tr.contentBlocks && tr.contentBlocks.length > 0) {
            const extraText = tr.contentBlocks
              .filter(
                (cb): cb is Extract<ContentBlock, { type: "text" }> =>
                  cb.type === "text",
              )
              .map((cb) => cb.text);
            if (extraText.length > 0) {
              textContent = textContent + "\n" + extraText.join("\n");
            }
            for (const cb of tr.contentBlocks) {
              if (cb.type === "image") toolResultImages.push(cb);
            }
          }
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.is_error ? `[ERROR] ${textContent}` : textContent,
          });
        }

        // Emit remaining content + any tool result images as a user message.
        // Images from tool results (e.g. browser_screenshot) must go in a user
        // message because OpenAI-compatible APIs don't support images in tool messages.
        const userContent = [...otherBlocks, ...toolResultImages];
        if (userContent.length > 0) {
          result.push(this.toOpenAIUserMessage(userContent));
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
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] =
      [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          textParts.push(block.text);
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
        case "server_tool_use":
          textParts.push(`[Web search: ${block.name}]`);
          break;
        case "web_search_tool_result":
          textParts.push("[Web search results]");
          break;
        // thinking, redacted_thinking, image — not applicable for OpenAI assistant messages
      }
    }

    const result: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam =
      {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
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
    if (blocks.length === 1 && blocks[0].type === "text") {
      return { role: "user", content: blocks[0].text };
    }

    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;
        case "image":
          if (!OPENAI_SUPPORTED_IMAGE_TYPES.has(block.source.media_type)) {
            parts.push({
              type: "text",
              text: `[Image: ${block.source.media_type} — format not supported by this provider]`,
            });
          } else {
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
          }
          break;
        case "file":
          parts.push({
            type: "text",
            text: this.fileBlockToText(block),
          });
          break;
        case "server_tool_use":
          parts.push({
            type: "text",
            text: `[Web search: ${block.name}]`,
          });
          break;
        case "web_search_tool_result":
          parts.push({ type: "text", text: "[Web search results]" });
          break;
      }
    }

    return { role: "user", content: parts };
  }

  private fileBlockToText(
    block: Extract<ContentBlock, { type: "file" }>,
  ): string {
    const header = `<attached_file name="${escapeXmlAttr(
      block.source.filename,
    )}" type="${escapeXmlAttr(block.source.media_type)}" />`;
    if (block.extracted_text && block.extracted_text.trim().length > 0) {
      return `${header}\n${block.extracted_text}`;
    }
    return `${header}\nNo extracted text available.`;
  }
}
